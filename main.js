const fs = require("fs");
const _ = require("lodash");
const Aimastering = require('aimastering');
const program = require('commander');
const srs = require('secure-random-string');

program
    .option('-i, --input <s>', 'Input audio file path')
    .option('-o, --output <s>', 'Output audio file path')
    .parse(process.argv);

if (!program.input || !program.output) {
    program.help();
}

const callApiDeferred = async function (api, method) {
    const apiArguments = Array.prototype.slice.call(arguments, 2);

    return new Promise((resolve, reject) => {
        const callback = (error, data, response) => {
            if (error) {
                // Если API возвращает JSON с ошибкой, передаем его
                try {
                    const parsedError = JSON.parse(error.response.text);
                    reject(new Error(parsedError.message || error.message));
                } catch (e) {
                    reject(error);
                }
            } else {
                resolve(data, response);
            }
        };
        const args = _.flatten([
            apiArguments,
            callback
        ]);

        method.apply(api, args);
    });
};

const sleep = async function (ms) { // Можно использовать промисифицированный setTimeout
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

const main = async function () {

    const client = Aimastering.ApiClient.instance;
    const bearer = client.authentications['bearer'];

    bearer.apiKey = 'guest_' + srs({length: 32}); // Генерируем новый ключ для каждой обработки

    const audioApi = new Aimastering.AudioApi(client);
    const masteringApi = new Aimastering.MasteringApi(client);

    try {
        const inputAudioData = fs.createReadStream(program.input);
        const inputAudio = await callApiDeferred(audioApi, audioApi.createAudio, {
            'file': inputAudioData,
        });
        console.error("Audio API response (input):", inputAudio);

        let mastering = await callApiDeferred(masteringApi, masteringApi.createMastering, inputAudio.id, {
            'mode': 'default',
        });
        console.error("Mastering API initial response (creation):", mastering);

        // Расширенный цикл ожидания
        while (mastering.status === 'waiting' || mastering.status === 'processing') {
            await sleep(5000); // Ожидаем перед следующим запросом статуса
            mastering = await callApiDeferred(masteringApi, masteringApi.getMastering, mastering.id);
            console.error('Обработано: '
                + (100 * (mastering.progression || 0)).toFixed() + '% (Статус: ' + mastering.status + ')');
        }

        // Проверяем, что мастеринг успешно завершен и имеет output_audio_id
        if (mastering.status === 'succeeded' && mastering.output_audio_id) {
            console.error("Мастеринг завершен. Output Audio ID:", mastering.output_audio_id);
            const outputAudioData = await callApiDeferred(audioApi, audioApi.downloadAudio, mastering.output_audio_id);
            fs.writeFileSync(program.output, outputAudioData);
            console.error('Выходной файл был записан в ' + program.output);
        } else if (mastering.status === 'error') {
            const errorMessage = `Мастеринг завершился ошибкой: ${mastering.falure_reason || 'неизвестная причина'}`;
            console.error(errorMessage);
            throw new Error(errorMessage);
        }
        else {
            const errorMessage = `Мастеринг завершился со статусом "${mastering.status}" но без output_audio_id. Подробности: ${JSON.stringify(mastering)}`;
            console.error(errorMessage);
            throw new Error(errorMessage);
        }
    } catch (error) {
        console.error('Произошла ошибка в процессе мастеринга:', error.message || error);
        // Дополнительная отладка: выводим весь объект ошибки, если доступен
        if (error.response && error.response.text) {
             console.error('Подробности ответа API:', error.response.text);
        }
        process.exit(1); // Завершаем процесс с кодом ошибки, чтобы server.js получил сигнал об ошибке
    }
};

main();