# Decentracord

Decentracord is a self-hosted browser messenger for one organization.

See [the installation guide](docs/installation.md) for VPS requirements, secrets, DNS, HTTPS, and the bootstrap command.

Browser assets and API requests come from the installation host; the client does not load external fonts or analytics. The app and database stay on a private Compose network. Caddy needs outbound access to an ACME certificate authority to issue and renew HTTPS certificates.
