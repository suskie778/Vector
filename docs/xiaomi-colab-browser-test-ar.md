# اختبار Xiaomi من داخل متصفح Google Colab

النسخة السابقة كانت تفتح `notificationUrl` في متصفحك المحلي، بينما جلسة
الطلب بقيت داخل Colab. لذلك لم ترَ Xiaomi التحقق على نفس الـCookies، وكانت
تعيد رابطاً جديداً كل مرة.

هذه النسخة تشغّل Chromium داخل Colab مع سطح مكتب VNC. التحقق يتم في نفس
المتصفح الذي سيُقرأ منه `userId` و`passToken` و`deviceId`.

## خلية التثبيت

شغّل هذه الخلية مرة واحدة:

```python
!apt-get -qq update
!apt-get -qq install -y chromium chromium-driver xvfb x11vnc novnc websockify
!pip -q install selenium requests
```

## خلية التشغيل

ارفع الملف:

```text
docs/xiaomi-colab-browser-test.py
```

ثم شغّله:

```python
%run /content/xiaomi-colab-browser-test.py
```

سيظهر سطح مكتب Chromium داخل Colab. السكربت يملأ بيانات الدخول إن وجد
حقولاً واضحة، ثم يمكنك إكمال أي تحقق من Xiaomi يدوياً داخل سطح المكتب نفسه.
لا تستخدم متصفحاً خارجياً لهذه الخطوة.

بعد ظهور نجاح واضح في صفحة Xiaomi، ارجع إلى Colab واضغط Enter. سيطبع السكربت
حالة وجود الكوكيز فقط:

```text
userId
passToken
serviceToken
deviceId
```

ولا يطبع القيم.

إذا أدخلت رابط Worker، سيشغل أيضاً:

```text
POST /api/session
POST /api/userinfo
```

السكربت لا ينفذ `fastboot` ولا يطلب `encryptData` ولا يمسح الهاتف. هذا الفصل
مقصود حتى يتم التأكد من الحساب والأهلية أولاً.

إذا ظهر سطح المكتب فارغاً، انتظر عدة ثوانٍ ثم اضغط داخل سطح المكتب. لا تفتح
رابط التحقق في متصفحك المحلي؛ يجب إكماله داخل Chromium الظاهر في Colab حتى
تبقى Cookies جلسة التحقق نفسها.