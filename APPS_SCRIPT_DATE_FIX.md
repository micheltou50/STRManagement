# Apps Script Date Normalization Fix (minimal edit)

Apply the following **exact edits** to your Apps Script file.

## 1) Add helper function (place above `parseEmailWithClaude`)

```javascript
function normalizeFutureDate(dateStr) {
  if (!dateStr) return dateStr;
  var m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;

  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(d.getTime())) return dateStr;

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  if (d < today) d.setFullYear(d.getFullYear() + 1);

  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
```

## 2) Update `parseEmailWithClaude()` right after `JSON.parse(text)`

Replace this line:

```javascript
return JSON.parse(text);
```

With this block:

```javascript
var parsed = JSON.parse(text);

parsed.checkin = normalizeFutureDate(parsed.checkin);
parsed.checkout = normalizeFutureDate(parsed.checkout);

if (parsed.checkin && parsed.checkout) {
  var checkinDate = new Date(parsed.checkin + 'T00:00:00');
  var checkoutDate = new Date(parsed.checkout + 'T00:00:00');

  if (!isNaN(checkinDate.getTime()) && !isNaN(checkoutDate.getTime())) {
    if (checkoutDate <= checkinDate) {
      checkoutDate.setFullYear(checkoutDate.getFullYear() + 1);
      parsed.checkout = Utilities.formatDate(checkoutDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }

    parsed.nights = Math.ceil((new Date(parsed.checkout + 'T00:00:00') - new Date(parsed.checkin + 'T00:00:00')) / 86400000);
  }
}

return parsed;
```
