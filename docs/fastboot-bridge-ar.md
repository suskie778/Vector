# تشغيل الجسر المحلي مع fastboot

الملف المحسّن `unlock-mi-easier.optimized.js` هو Worker، وليس برنامجاً
محلياً يتصل مباشرةً بـ USB. الملف `scripts/src/fastboot-bridge.mjs` هو الجسر
المحلي الذي يقرأ الهاتف عبر `fastboot` ويستدعي الـ Worker.

## المتطلبات

1. تثبيت Android Platform Tools وإضافة مجلد `fastboot` إلى `PATH`.
2. تشغيل الهاتف في وضع fastboot عبر Volume Down + Power ثم توصيل USB.
3. نشر Worker والحصول على رابطه.
4. ملف جلسة رسمي `session.json` صادر من `POST /api/session`. لا تضع كلمة
   المرور داخل الملف؛ الـ Worker يقبل `passToken` الرسمي فقط.

إذا كان `fastboot` غير موجود في `PATH`، يمكن تحديد مساره مباشرة:

```powershell
$env:FASTBOOT_BIN="C:\Android\platform-tools\fastboot.exe"
```

## فحص الاتصال

```bash
pnpm --filter @workspace/scripts run fastboot:bridge -- devices
pnpm --filter @workspace/scripts run fastboot:bridge -- inspect
```

## طلب ملف التفويض

```bash
pnpm --filter @workspace/scripts run fastboot:bridge -- unlock \
  --worker-url https://YOUR-WORKER.example \
  --session ./session.json \
  --region global \
  --output encryptData
```

يمكن وضع الرابط بدلاً من ذلك في:

```bash
export XIAOMI_WORKER_URL="https://YOUR-WORKER.example"
```

وإذا كان الـ Worker مضبوطاً على `WORKER_AUTH_TOKEN`، ضع الرمز في متغير
بيئة محلي ولا تكتبه داخل السكربت:

```bash
export XIAOMI_WORKER_TOKEN="..."
```

بعد موافقة Xiaomi وحفظ `encryptData`، سيطبع السكربت:

```bash
fastboot stage encryptData
fastboot oem unlock
fastboot reboot
```

أمر `fastboot oem unlock` يمسح بيانات الهاتف، لذلك السكربت لا يشغله تلقائياً.
