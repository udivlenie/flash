const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

// Директории для временного хранения файлов
const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.join(__dirname, 'output');

// Создаем директории, если их нет
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
}

// Настройка Multer для загрузки файлов
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        // Добавляем timestamp к имени файла, чтобы избежать коллизий
        const ext = path.extname(file.originalname);
        cb(null, `${path.basename(file.originalname, ext)}-${Date.now()}${ext}`);
    }
});
const upload = multer({ storage: storage });

// Подача статических файлов из папки 'public'
app.use(express.static(path.join(__dirname, 'public')));
// Подача файлов из папки 'output' для скачивания
app.use('/output', express.static(outputDir));

app.post('/process-audio', upload.single('audioFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл не был загружен.' });
    }

    const inputFullPath = req.file.path; // Полный путь к загруженному файлу
    const originalFileName = req.file.originalname;
    const baseName = path.basename(originalFileName, path.extname(originalFileName));
    const outputFileName = `${baseName}_output.wav`; // Имя выходного файла
    const outputFullPath = path.join(outputDir, outputFileName);

    console.log(`Получен файл: ${inputFullPath}`);
    console.log(`Ожидаемый выходной файл: ${outputFullPath}`);

    // Формируем команду для выполнения main.js
    const command = `node main.js --input "${inputFullPath}" --output "${outputFullPath}"`;

    exec(command, (error, stdout, stderr) => {
        // Очищаем временный входной файл после обработки
        fs.unlink(inputFullPath, (err) => {
            if (err) console.error(`Ошибка при удалении файла ${inputFullPath}:`, err);
        });

        if (error) {
            console.error(`Ошибка выполнения main.js: ${error.message}`);
            console.error(`stderr: ${stderr}`);
            // Проверяем, существует ли outputFullPath, и если нет, добавляем сообщение
            if (!fs.existsSync(outputFullPath)) {
                return res.status(500).json({ error: `Ошибка при обработке аудио: ${error.message}. Выходной файл не был создан.`, details: stderr });
            }
            return res.status(500).json({ error: `Ошибка при обработке аудио: ${error.message}`, details: stderr });
        }
        if (stderr) {
            console.warn(`main.js stderr: ${stderr}`); // Не всегда ошибка, может быть предупреждение
        }
        console.log(`main.js stdout: ${stdout}`);

        // Проверяем, существует ли выходной файл
        if (fs.existsSync(outputFullPath)) {
            res.json({ message: 'Аудио успешно обработано!', outputFileName: outputFileName });
        } else {
            console.error(`Выходной файл не найден: ${outputFullPath}`);
            res.status(500).json({ error: 'Обработка завершена, но выходной файл не был создан или не найден.' });
        }
    });
});

app.listen(port, () => {
    console.log(`Сервер запущен на http://localhost:${port}`);
    console.log(`Папка для загрузок: ${uploadsDir}`);
    console.log(`Папка для вывода: ${outputDir}`);
});