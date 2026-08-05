# اختبار الحساب التجريبي وإنشاء session

أضفنا سكربت تسجيل دخول محلي اسمه `xiaomi-session.mjs`. يقرأ الأسرار وقت
التشغيل من:

```text
Username
Password
```

ولا يطبع القيم ولا يرسلها إلى أي مكان غير endpoint تسجيل الدخول الرسمي لدى
Xiaomi. لا يمكن للسكربت تجاوز CAPTCHA أو فحص الحساب أو مدة الانتظار.

## التشغيل

يجب تزويده بمعرّف الجهاز/المتصفح المستخدم في جلسة Xiaomi:

```bash
pnpm --filter @workspace/scripts run auth:session -- \
  --device-id wb_YOUR_DEVICE_ID \
  --output ./session.json
```

إذا كانت الأسرار متاحة في Workflow كـ Replit Secrets، سيقرأها السكربت تلقائياً.
يمكن تحديد اسم الملف الناتج عبر `--output`.

عند النجاح سيُنشئ:

```text
session.json
```

ثم شغّل:

```bash
pnpm --filter @workspace/scripts run fastboot:bridge -- inspect

pnpm --filter @workspace/scripts run fastboot:bridge -- unlock \
  --worker-url https://YOUR-WORKER.example \
  --session ./session.json \
  --region global
```

إذا أعادت Xiaomi كود `87001` أو طلبت CAPTCHA، فهذا يعني أن الحساب يحتاج
تأكيداً عبر المتصفح الرسمي. إذا أعادت كود أهلية أو انتظار، سيظهر السبب ولن
يحاول السكربت تخطيه.
