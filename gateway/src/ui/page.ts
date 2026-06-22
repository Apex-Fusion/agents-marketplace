/**
 * gateway/src/ui/page.ts — self-serve web UI, inlined as a string so it ships
 * in dist/ (tsc does not copy .html). Plain HTML + fetch, no build step.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vector Marketplace — OpenAI Gateway</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  code, pre { background: #f4f4f5; border-radius: 4px; padding: .15rem .35rem; }
  pre { padding: .75rem; overflow-x: auto; }
  input, button { font-size: 1rem; padding: .45rem .6rem; border-radius: 6px; border: 1px solid #ccc; }
  button { background: #111; color: #fff; cursor: pointer; border: none; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .5rem 0; }
  .key { background: #fffbe6; border: 1px solid #f5d90a; padding: .75rem; border-radius: 6px; word-break: break-all; }
  .muted { color: #666; font-size: .9rem; }
</style>
</head>
<body>
<h1>Vector Marketplace — OpenAI-compatible Gateway</h1>
<p class="muted">Point any OpenAI SDK at <code id="base"></code> using your API key as the bearer token.</p>

<h2>1. Create an API key</h2>
<div class="row">
  <input id="label" placeholder="label (optional)" />
  <button onclick="signup()">Create key</button>
</div>
<div id="signupOut"></div>

<h2>2. Fund your wallet</h2>
<p class="muted">Send AP3X to your deposit address (you need price + bonds + ~5 ADA collateral + fees).</p>

<h2>3. Account</h2>
<div class="row">
  <input id="apiKey" placeholder="vk_..." style="flex:1; min-width: 320px" />
  <button onclick="account()">Check account</button>
</div>
<div id="acctOut"></div>

<h2>4. Withdraw</h2>
<div class="row">
  <input id="toAddr" placeholder="addr... (destination)" style="flex:1; min-width: 320px" />
  <input id="amt" placeholder="amount lovelace (blank = all)" />
  <button onclick="withdraw()">Withdraw</button>
</div>
<div id="wOut"></div>

<script>
document.getElementById('base').textContent = location.origin + '/openai/v1';
function pre(id, obj){ document.getElementById(id).innerHTML = '<pre>'+JSON.stringify(obj,null,2)+'</pre>'; }
async function signup(){
  const label = document.getElementById('label').value;
  const r = await fetch('/signup', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({label})});
  const j = await r.json();
  if (j.api_key) {
    document.getElementById('signupOut').innerHTML =
      '<div class="key"><b>API key (shown once):</b><br>'+j.api_key+'<br><br><b>Deposit address:</b><br>'+j.deposit_address+'</div>';
    document.getElementById('apiKey').value = j.api_key;
    document.getElementById('toAddr').value = '';
  } else pre('signupOut', j);
}
function authHeaders(){ return {'authorization':'Bearer '+document.getElementById('apiKey').value, 'content-type':'application/json'}; }
async function account(){
  const r = await fetch('/account', {headers: authHeaders()});
  pre('acctOut', await r.json());
}
async function withdraw(){
  const to_address = document.getElementById('toAddr').value;
  const amt = document.getElementById('amt').value.trim();
  const body = amt ? {to_address, amount_lovelace: amt} : {to_address};
  const r = await fetch('/account/withdraw', {method:'POST', headers: authHeaders(), body: JSON.stringify(body)});
  pre('wOut', await r.json());
}
</script>
</body>
</html>`;
