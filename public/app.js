document.addEventListener('DOMContentLoaded', () => {
    const audioInput = document.getElementById('audioInput');
    const processButton = document.getElementById('processButton');
    const fileNameDisplay = document.getElementById('fileNameDisplay');
    const outputFileNameDisplay = document.getElementById('outputFileNameDisplay');
    const outputAudio = document.getElementById('outputAudio');
    const downloadLink = document.getElementById('downloadLink');
    const statusMessage = document.getElementById('statusMessage');
    const resultCard = document.querySelector('.result-card');

    let uploadedFile = null;

    // Функция для отображения сообщений о статусе
    function showStatus(message, type) {
        statusMessage.textContent = message;
        statusMessage.className = `status-message ${type}`;
        statusMessage.style.display = 'block';
    }

    // Функция для скрытия сообщений о статусе
    function hideStatus() {
        statusMessage.style.display = 'none';
        statusMessage.textContent = '';
        statusMessage.className = 'status-message';
    }

    audioInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            uploadedFile = file;
            fileNameDisplay.textContent = `Выбран файл: ${file.name}`;
            processButton.disabled = false;
            hideStatus();
            resultCard.style.display = 'none';
            outputAudio.style.display = 'none';
            downloadLink.style.display = 'none';
        } else {
            uploadedFile = null;
            fileNameDisplay.textContent = '';
            processButton.disabled = true;
        }
    });

    processButton.addEventListener('click', async () => {
        if (!uploadedFile) {
            showStatus('Пожалуйста, выберите аудиофайл для обработки.', 'error');
            return;
        }
       processButton.disabled = true;
        showStatus('Обработка файла... Это может занять некоторое время.', 'info');
        resultCard.style.display = 'none'; // Скрываем результат перед новой обработкой
        outputAudio.style.display = 'none';
        downloadLink.style.display = 'none';

        const formData = new FormData();
        formData.append('audioFile', uploadedFile);

        try {
            const response = await fetch('/process-audio', {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Ошибка при обработке файла');
            }

            const result = await response.json();
            
            if (result.outputFileName) {
                const outputFileName = result.outputFileName;
                outputFileNameDisplay.textContent = `Обработанный файл: ${outputFileName}`;
                outputAudio.src = `/output/${outputFileName}`; // Путь к файлу на сервере
                outputAudio.style.display = 'block';
                downloadLink.href = `/output/${outputFileName}`;
                downloadLink.download = outputFileName; // Имя для скачивания
                downloadLink.style.display = 'inline-block';
                resultCard.style.display = 'block';
                showStatus('Файл успешно обработан!', 'success');
            } else {
                throw new Error('Сервер не вернул имя выходного файла.');
            }

        } catch (error) {
            console.error('Ошибка:', error);
            showStatus(`Ошибка: ${error.message}`, 'error');
        } finally {
            processButton.disabled = false;
        }
    });
});
