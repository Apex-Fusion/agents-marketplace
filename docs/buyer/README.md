# Vector Buyer App

A self-contained app for purchasing AI compute on the Vector L2 testnet (Cardano). You submit prompts, pay with AP3X tokens via on-chain escrow, and receive LLM responses from supplier nodes.

## How It Works

1. You type a **prompt** and set a **payment** amount in the web UI
2. The app posts an **escrow transaction** on-chain, locking your payment + bond
3. The app sends the task to a **supplier node** via HTTP
4. The supplier calls an LLM, **claims** the escrow, and **submits** the result hash on-chain
5. You see the response in the UI and can **accept** to release payment, or **dispute**

All on-chain settlement happens automatically. You just interact with the web UI.

## Quick Start

### 1. Install Python

You need Python 3.9 or newer. Download from https://www.python.org/downloads/

### 2. Create a virtual environment

```bash
cd buyer
python -m venv .venv

# Windows:
.venv\Scripts\activate

# macOS/Linux:
source .venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure your environment

Copy the example file and fill in your values:

```bash
copy .env.example .env
```

Edit `.env` with your settings:

```
# Your wallet seed phrase (15 words)
BUYER_MNEMONIC=word1 word2 word3 ... word15

# Supplier URLs (comma-separated)
SUPPLIER_URLS=http://SUPPLIER_IP:9000

# Port to run on (default 8080)
BUYER_PORT=8080
```

The other values (VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, ESCROW_SCRIPT_HASH, RESOLVER_ADDRESS) are pre-configured for the Vector testnet and should not need changing.

### 5. Fund your wallet

Your buyer wallet needs AP3X to pay for compute tasks and escrow bonds. You need at least **10 AP3X** to get started.

When you start the app, the UI header shows your wallet address and balance. Send AP3X to that address.

### 6. Start the app

```bash
python main.py
```

You will see:
```
Starting Vector Buyer App on port 8080
UI: http://localhost:8080
```

### 7. Open the web UI

Go to **http://localhost:8080** in your browser.

## Using the Web UI

### Submitting a Task

1. Type your prompt in the text area
2. Set the payment amount with the slider (in AP3X)
3. Select a supplier from the dropdown
4. Click **Submit Task**
5. Wait for the response (typically 15-40 seconds)

The app will:
- Post the escrow on-chain (locks payment + 1 AP3X bond)
- Send the task to the supplier
- Display the response when ready

### Accepting a Result

After receiving a response, click **Accept & Pay** to release payment to the supplier. This completes the on-chain escrow lifecycle.

If you do not accept:
- Your payment stays locked in escrow
- After the dispute window (10 minutes), the supplier can collect payment automatically
- You lose your bond (1 AP3X) as a penalty for not responding

### Task History

Click **Task History** in the nav bar to see all past tasks. Click any task to expand it and see full details including TX hashes.

## Connecting to a Supplier

You need at least one supplier URL. The supplier operator will give you their URL.

**Same machine (testing):**
```
SUPPLIER_URLS=http://localhost:9000
```

**Local network:**
```
SUPPLIER_URLS=http://192.168.1.50:9000
```

**Remote / internet:**
```
SUPPLIER_URLS=http://supplier.example.com:9000
```

**Multiple suppliers:**
```
SUPPLIER_URLS=http://supplier1.com:9000,http://supplier2.com:9000
```

The app auto-discovers which suppliers are online and shows them in the dropdown.

## File Structure

```
buyer/
  main.py              Entry point - starts the web server
  config.py            Loads settings from .env
  wallet.py            Initializes blockchain wallet
  api.py               HTTP API endpoints
  task_manager.py      Orchestrates the full buy flow
  escrow_ops.py        On-chain escrow transactions
  supplier_client.py   HTTP client for talking to suppliers
  discovery.py         Auto-discovers online suppliers
  storage.py           Task history (JSON file)
  .env                 Your configuration (secret - do not share)
  .env.example         Template for .env
  requirements.txt     Python dependencies
  static/
    app.html           Web UI
  lib/                 Blockchain utilities
    constants.py       Protocol constants
    chain.py           Chain query helpers
    datum.py           CBOR datum builders
    escrow_tx.py       Transaction builder
    blueprint.py       Smart contract loader
    protocol.py        API data models
  contracts/
    escrow/
      plutus.json      Compiled smart contract
  data/
    tasks.json         Task history (auto-created)
```

## Configuration Reference

| Variable | Description | Default |
|----------|-------------|---------|
| VECTOR_OGMIOS_URL | Blockchain node URL | Vector testnet |
| VECTOR_SUBMIT_URL | TX submission URL | Vector testnet |
| BUYER_MNEMONIC | Your 15-word wallet seed phrase | (required) |
| ESCROW_SCRIPT_HASH | Escrow contract hash | Pre-configured |
| RESOLVER_ADDRESS | Dispute resolver address | Pre-configured |
| SUPPLIER_URLS | Comma-separated supplier URLs | (required) |
| BUYER_PORT | HTTP port for the web UI | 8080 |

## Cost Breakdown

Each task costs:
- **Payment**: The amount you set (e.g. 5 AP3X) - goes to the supplier
- **Buyer bond**: 1 AP3X - returned to you when you accept
- **TX fees**: ~0.2-0.5 AP3X per transaction (escrow post + accept = 2 TXs)

If you accept the result, you get your 1 AP3X bond back. Total cost = payment + fees.

## Security Notes

- **Never share your .env file** - it contains your wallet seed phrase
- **Never share your data/ folder** - it contains task history
- The seed phrase controls your wallet funds. Back it up securely.
- Escrow protects you: the supplier cannot take your funds without delivering a result
- You have a 10-minute dispute window after receiving a result

## Troubleshooting

**"No module named 'vector_agent'"**
- Make sure you installed dependencies: `pip install -r requirements.txt`

**"ogmios_url required"**
- Make sure your .env file exists and is in the buyer/ folder

**"No supplier URL provided"**
- Add at least one supplier URL to SUPPLIER_URLS in your .env

**"0 suppliers available" in the UI**
- The supplier node may be offline. Check with the supplier operator.
- Verify the URL is correct and reachable from your machine.

**Balance shows 0 or very low**
- Fund your wallet by sending AP3X to the address shown in the UI header.

**Task fails with timeout**
- The supplier may be overloaded. Try again or use a different supplier.
- Check your internet connection to both the supplier and the Vector testnet.
