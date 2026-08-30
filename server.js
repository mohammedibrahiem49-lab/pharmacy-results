const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });
const JWT_SECRET = 'pharmacy_secret_key_2027';

// متغير وضع الصيانة في الذاكرة
let isMaintenanceMode = false;

// --- إعدادات بوت التلغرام ---
const TELEGRAM_BOT_TOKEN = '8805199096:AAFMgLALXIIdMzaRZKFtRdeuPAGTYy3tR-0';
const TELEGRAM_CHAT_ID = '@ph_results';

// دالة إرسال الإشعارات عبر التلغرام
async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });
        const data = await res.json();
        return data.ok;
    } catch (err) {
        console.error('خطأ أثناء إرسال إشعار التلغرام:', err.message);
        return false;
    }
}

app.use(cors());
app.use(express.json());

// 1. الاتصال بقاعدة البيانات وإنشاء الجداول
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error("خطأ بقاعدة البيانات:", err.message);
    else console.log('تم الاتصال بقاعدة البيانات SQLite بنجاح.');
});

db.serialize(() => {
    // جدول الطلاب (يتضمن عمود الحجب)
    db.run(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT,
            exam_number TEXT,
            stage TEXT,
            term TEXT,
            is_blocked TEXT DEFAULT 'لا'
        )
    `);

    // جدول الدرجات
    db.run(`
        CREATE TABLE IF NOT EXISTS grades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER,
            subject_name TEXT,
            grade_value TEXT,
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )
    `);

    // جدول الإعدادات لحفظ وضع الصيانة عند إعادة تشغيل السيرفر
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `, () => {
        db.get(`SELECT value FROM settings WHERE key = 'maintenance'`, (err, row) => {
            if (row) {
                isMaintenanceMode = (row.value === 'true');
            }
        });
    });
});

// دالة التحقق من الـ Token للـ Admin
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'غير مصرح بالدخول' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'انتهت الجلسة، يرجى إعادة تسجيل الدخول' });
        req.user = user;
        next();
    });
}

// 2. تسجيل دخول الأدمن
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'pharmacy2027') {
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
        return res.json({ token });
    }
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة السر غير صحيحة' });
});

// --- مسارات وضع الصيانة ---

// فحص حالة الصيانة (عام للواجهة)
app.get('/api/maintenance', (req, res) => {
    res.json({
        maintenance: isMaintenanceMode,
        message: 'المنصة تحت الصيانة حالياً لرفع النتائج'
    });
});

// دالة معالجة تغيير وضع الصيانة
const handleToggleMaintenance = (req, res) => {
    const { maintenance } = req.body;
    isMaintenanceMode = (maintenance === true || maintenance === 'true');

    db.run(
        `INSERT OR REPLACE INTO settings (key, value) VALUES ('maintenance', ?)`,
        [String(isMaintenanceMode)],
        (err) => {
            if (err) return res.status(500).json({ error: 'حدث خطأ أثناء حفظ حالة الصيانة' });
            res.json({
                message: isMaintenanceMode ? 'تم تفعيل وضع الصيانة وإيقاف البحث' : 'تم إيقاف وضع الصيانة وفتح البحث للطلاب',
                maintenance: isMaintenanceMode
            });
        }
    );
};

// التبديل بين تفعيل وإلغاء وضع الصيانة (يدعم كلاً من المسارين لمنع خطأ 404)
app.post('/api/toggle-maintenance', authenticateToken, handleToggleMaintenance);
app.post('/api/maintenance', authenticateToken, handleToggleMaintenance);

// 3. رفع ملف الـ Excel وقراءة عمود الحجب
app.post('/api/upload-excel', authenticateToken, upload.single('excelFile'), (req, res) => {
    const { stage, term } = req.body;
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع أي ملف' });

    try {
        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheetData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        db.serialize(() => {
            sheetData.forEach((row) => {
                const fullName = row['الاسم الرباعي'] || row['اسم الطالب'] || row['الاسم'];
                const examNumber = String(row['الرقم الامتحاني'] || row['الرقم'] || '').trim();
                
                // التثبت من حالة الحجب من عمود (الحجب)
                const isBlocked = (row['الحجب'] && String(row['الحجب']).trim() === 'نعم') ? 'نعم' : 'لا';

                if (fullName && examNumber) {
                    // حذف السجل القديم إن وجد لنفس الطالب بنفس المرحلة والكورس
                    db.run(`DELETE FROM students WHERE exam_number = ? AND stage = ? AND term = ?`, [examNumber, stage, term], function() {
                        // إضافة الطالب جديد
                        db.run(
                            `INSERT INTO students (full_name, exam_number, stage, term, is_blocked) VALUES (?, ?, ?, ?, ?)`,
                            [fullName, examNumber, stage, term, isBlocked],
                            function(err) {
                                if (err) return;
                                const studentId = this.lastID;

                                // إدخال الدرجات
                                Object.keys(row).forEach((key) => {
                                    if (!['الاسم الرباعي', 'اسم الطالب', 'الاسم', 'الرقم الامتحاني', 'الرقم', 'الحجب'].includes(key)) {
                                        const gradeValue = row[key];
                                        if (gradeValue !== undefined && gradeValue !== null) {
                                            db.run(
                                                `INSERT INTO grades (student_id, subject_name, grade_value) VALUES (?, ?, ?)`,
                                                [studentId, key, String(gradeValue)]
                                            );
                                        }
                                    }
                                });
                            }
                        );
                    });
                }
            });
        });

        // إرسال إشعار تلقائي إلى قناة التلغرام عند نجاح الرفع
        const telegramMsg = `🎓 <b>جامعة البصرة - كلية الصيدلة</b>\n\n✅ <b>تم رفع ونشر النتائج بنجاح!</b>\n📌 <b>المرحلة:</b> ${stage}\n📚 <b>الكورس:</b> ${term}\n\nيمكنكم الآن الدخول للواجهة والاستعلام عن النتائج.\n\n<i>this website powered by <b>Ph.Mohammed ibrahim</b></i>`;
        sendTelegramNotification(telegramMsg);

        res.json({ message: 'تم رفع ومعالجة ملف النتائج والحجب بنجاح!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'حدث خطأ أثناء قراءة ملف الـ Excel' });
    }
});

// 4. مسار إرسال إعلان يدوياً إلى قناة التلغرام من لوحة التحكم
app.post('/api/send-telegram', authenticateToken, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'نص الرسالة مطلوب' });

    const formattedMsg = `📢 <b>جامعة البصرة - كلية الصيدلة</b>\n\n${message}\n\n<i>this website powered by <b>Ph.Mohammed ibrahim</b></i>`;
    const success = await sendTelegramNotification(formattedMsg);

    if (success) {
        res.json({ message: 'تم نشر الإشعار على القناة بنجاح!' });
    } else {
        res.status(500).json({ error: 'فشل إرسال الإشعار، تأكد من إعدادات البوت والقناة.' });
    }
});

// 5. استعلام الطالب عن النتيجة
app.get('/api/result/:stage/:term/:examNumber', (req, res) => {
    // التحقق المباشر من وضع الصيانة
    if (isMaintenanceMode) {
        return res.status(503).json({
            maintenance: true,
            message: 'المنصة تحت الصيانة حالياً لرفع النتائج'
        });
    }

    const { stage, term, examNumber } = req.params;

    db.get(
        `SELECT * FROM students WHERE stage = ? AND term = ? AND exam_number = ?`,
        [stage, term, examNumber],
        (err, student) => {
            if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });
            if (!student) return res.status(404).json({ message: 'لم يتم العثور على نتيجة لهذا الرقم الامتحاني في هذه المرحلة والكورس!' });

            db.all(
                `SELECT subject_name, grade_value FROM grades WHERE student_id = ?`,
                [student.id],
                (err, grades) => {
                    if (err) return res.status(500).json({ error: 'خطأ بالسيرفر' });

                    res.json({
                        student: {
                            full_name: student.full_name,
                            exam_number: student.exam_number,
                            stage: student.stage,
                            term: student.term,
                            is_blocked: student.is_blocked || 'لا'
                        },
                        grades: grades
                    });
                }
            );
        }
    );
});

app.listen(3000, () => {
    console.log('السيرفر يعمل بنجاح على المنفذ http://localhost:3000');
    console.log('this website powered by \x1b[36mPh.Mohammed ibrahim\x1b[0m');
});