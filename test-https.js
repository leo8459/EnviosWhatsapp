import fetch from "node-fetch";
import https from "https";

const url   = "https://172.65.10.51:8100/api/packagesRDD"; // SIN /public
const token = "eZMlItx6mQMNZjxoijEvf7K3pYvGGXMvEHmQcqvtlAPOEAPgyKDVOpyF7JP0ilbK";
const agent = new https.Agent({ rejectUnauthorized: false }); // SOLO pruebas

(async () => {
  let res = await fetch(url, {
    agent, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  console.log("Bearer →", res.status, res.headers.get("content-type"));
  let body = await res.text();
  console.log(body.slice(0, 300));

  if (!res.ok || !(res.headers.get("content-type")||"").includes("json")) {
    res = await fetch(url, { agent, headers: { token, Accept: "application/json" }});
    console.log("token →", res.status, res.headers.get("content-type"));
    body = await res.text();
    console.log(body.slice(0, 300));
  }
})();
