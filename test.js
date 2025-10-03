// test.js
import fetch from 'node-fetch';     // npm i node-fetch@3

const url   = 'https://trackingbo.correos.gob.bo:8100/api/packagesRDD';
const token = 'eZMlItx6mQMNZjxoijEvf7K3pYvGGXMvEHmQcqvtlAPOEAPgyKDVOpyF7JP0ilbK';

(async () => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  console.log('Status:', res.status);
  console.log('Content-Type:', res.headers.get('content-type'));
  console.log((await res.text()).slice(0, 300));
})();
