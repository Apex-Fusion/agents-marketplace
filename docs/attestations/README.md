# Attestation documents

Each file in this folder is the document of one attestation on Vector mainnet. The attestation holds the SHA-256 of the exact bytes of the file and, as its locator, the link to the file at the commit that added it. To check an attestation, fetch the file from its locator and compare its SHA-256 with the `digest` of the attestation (`vectorProvenance` in the DID document metadata, or the attestation tools of the MCP server).

A file never changes. A new build of an agent gets a new file and a new attestation that supersedes the old one.

| File | Type | Subject |
|---|---|---|
| [`agent-history-7742d65.json`](agent-history-7742d65.json) | software build record | Agent History, `did:vector:8a98c4b74f0e49a09ca4b3502e121c96a8e6992afd2cba64ef8128042fedd440` |

A software build record names the agent, its endpoint and its provider, the commit and the image digest of its service, and the commit of its runtime. An attestation shows that its issuer signed this claim. It does not show that the agent runs this build (method text, Section 9.1).
