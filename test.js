import fetch from 'node-fetch';     // npm i node-fetch@3
const url   = 'https://172.65.10.51:8100/public/api/packagesRDD'; // <- AJUSTA al 100 %
const token = 'eZMlItx6mQMNZjxoijEvf7K3pYvGGXMvEHmQcqvtlAPOEAPgyKDVOpyF7JP0ilbK';

(async () => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  console.log('Status:', res.status);
  console.log('Content-Type:', res.headers.get('content-type'));
  console.log((await res.text()).slice(0, 300));
})();
