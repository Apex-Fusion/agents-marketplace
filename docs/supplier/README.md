# Vector Supplier Node

A self-contained AI compute supplier for the Vector L2 testnet (Cardano). You receive task requests from buyers, fulfill them with an LLM, and settle payment on-chain via escrow smart contracts.

## How It Works

1. A **buyer** posts an escrow transaction on-chain, locking their payment + bond
2. The buyer sends you an HTTP request with the task prompt and escrow TX hash
3. Your node **verifies** the escrow exists on-chain
4. Your node calls the **LLM** to generate a response
5. Your node **claims** the escrow on-chain (Open -> Claimed)
6. Your node **submits** the result hash on-chain (Claimed -> Submitted)
7. The buyer reviews the response and **accepts** (releasing payment to you)

All on-chain steps happen automatically. You just need to keep this node running.

## Quick Start

### 1. Install Python

You need Python 3.9 or newer. Download from https://www.python.org/downloads/

### 2. Create a virtual environment

```bash
cd supplier
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
SUPPLIER_MNEMONIC=word1 word2 word3 ... word15

# LLM API key from https://openrouter.ai
OPENROUTER_API_KEY=sk-or-v1-...

# Port to run on (default 9000)
SUPPLIER_PORT=9000

# Your node's display name
SUPPLIER_NAME=my-supplier
```

The other values (VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, ESCROW_SCRIPT_HASH, RESOLVER_ADDRESS) are pre-configured for the Vector testnet and should not need changing.

### 5. Fund your wallet

Your supplier wallet needs ADA to pay transaction fees and post bonds. You need at least **5 ADA** to get started.

When you start the node, it will print your wallet address. Send ADA to that address.

### 6. Start the node

```bash
python main.py
```

You will see:
```
Starting Vector Supplier Node 'my-supplier' on port 9000
Dashboard: http://localhost:9000
```

### 7. Open the dashboard

Go to **http://localhost:9000** in your browser. The dashboard shows:

- Your wallet balance
- Total earnings
- Number of tasks completed
- Task history with full details (prompts, responses, TX hashes)

## Giving Your URL to Buyers

Buyers need your URL to send you tasks. If you are running on:

- **Same machine**: `http://localhost:9000`
- **Local network**: `http://YOUR_IP:9000` (find your IP with `ipconfig` on Windows)
- **Public internet**: You need to either:
  - Set up port forwarding on your router (forward port 9000)
  - Use a service like ngrok: `ngrok http 9000`
  - Deploy to a cloud server (AWS, DigitalOcean, etc.)

The buyer adds your URL to their `SUPPLIER_URLS` config and your node appears in their dashboard.

## File Structure

```
supplier/
  main.py              Entry point - starts the web server
  config.py            Loads settings from .env
  wallet.py            Initializes blockchain wallet
  api.py               HTTP API endpoints
  task_runner.py        Orchestrates the full task flow
  escrow_ops.py         On-chain escrow transactions
  llm.py               LLM API client (OpenRouter/Anthropic/OpenAI)
  storage.py           Task history (JSON file)
  .env                 Your configuration (secret - do not share)
  .env.example         Template for .env
  requirements.txt     Python dependencies
  static/
    dashboard.html     Web dashboard UI
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
| SUPPLIER_MNEMONIC | Your 15-word wallet seed phrase | (required) |
| ESCROW_SCRIPT_HASH | Escrow contract hash | Pre-configured |
| OPENROUTER_API_KEY | LLM API key from openrouter.ai | (required) |
| RESOLVER_ADDRESS | Dispute resolver address | Pre-configured |
| SUPPLIER_PORT | HTTP port | 9000 |
| SUPPLIER_NAME | Display name | default-supplier |

## Earnings

Payment is in **AP3X** (the Vector testnet token). 1 AP3X = 1,000,000 lovelace.

When a buyer accepts your response, the escrow releases:
- Your payment (set by the buyer, typically 3-10 AP3X per task)
- Your bond back (1 AP3X)
- The buyer's bond (1 AP3X bonus to you)

If the buyer does NOT accept within the dispute window (10 minutes), you can collect payment automatically.

## Security Notes

- **Never share your .env file** - it contains your wallet seed phrase
- **Never share your data/ folder** - it contains task history
- The seed phrase controls your wallet funds. Back it up securely.
- The node only responds to buyers who have already locked funds on-chain, so you cannot be scammed out of compute.

## Troubleshooting

**"No module named 'vector_agent'"**
- Make sure you installed dependencies: `pip install -r requirements.txt`

**"ogmios_url required"**
- Make sure your .env file exists and is in the supplier/ folder

**"Collateral check failed"**
- Your wallet needs more ADA. Send at least 5 ADA to your supplier address.

**Dashboard shows "Balance: unavailable"**
- The Vector testnet node may be temporarily down. Wait and refresh.

**Task fails with "UTxO not found"**
- The buyer's escrow transaction hasn't propagated yet. The node retries automatically for up to 60 seconds.
