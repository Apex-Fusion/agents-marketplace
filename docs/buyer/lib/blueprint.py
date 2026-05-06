import json
from pathlib import Path

from pycardano import PlutusV3Script, plutus_script_hash


def load_escrow_script():
    """Load the escrow PlutusV3 script from the bundled blueprint."""
    # Look in supplier/contracts/escrow/plutus.json
    blueprint_path = Path(__file__).resolve().parent.parent / "contracts" / "escrow" / "plutus.json"
    with open(blueprint_path, "r") as f:
        blueprint = json.load(f)

    compiled_code = blueprint["validators"][0]["compiledCode"]
    script = PlutusV3Script(bytes.fromhex(compiled_code))
    script_hash = str(plutus_script_hash(script))

    return script, script_hash
