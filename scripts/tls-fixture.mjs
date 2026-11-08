import { chmodSync, lstatSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function fail(code) {
  throw new Error(code);
}

function runOpenSsl(args) {
  const result = spawnSync("openssl", args, {
    encoding: "utf8",
    shell: false,
    stdio: "ignore",
    timeout: 60_000
  });
  if (result.error || result.status !== 0) fail("TLS_FIXTURE_GENERATION_FAILED");
}

function requiredDirectory(args) {
  if (args.length !== 2 || args[0] !== "--dir") fail("INVALID_ARGUMENTS");
  const directory = realpathSync(args[1]);
  if (!directory.startsWith("/tmp/decentracord-tls-")) fail("TLS_FIXTURE_DIRECTORY_INVALID");
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) fail("TLS_FIXTURE_DIRECTORY_INVALID");
  return directory;
}

function prepare(directory) {
  const caKey = `${directory}/ca.key`;
  const caCertificate = `${directory}/ca.crt`;
  const serverKey = `${directory}/server.key`;
  const serverRequest = `${directory}/server.csr`;
  const serverCertificate = `${directory}/server.crt`;
  const serverExtensions = `${directory}/server.ext`;
  const untrustedKey = `${directory}/untrusted-ca.key`;
  const untrustedCertificate = `${directory}/untrusted-ca.crt`;

  runOpenSsl([
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2",
    "-keyout", caKey, "-out", caCertificate, "-subj", "/CN=Decentracord TLS Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"
  ]);
  runOpenSsl([
    "req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", serverKey,
    "-out", serverRequest, "-subj", "/CN=proxy"
  ]);
  writeFileSync(serverExtensions, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:proxy",
    ""
  ].join("\n"), { mode: 0o600 });
  runOpenSsl([
    "x509", "-req", "-in", serverRequest, "-CA", caCertificate, "-CAkey", caKey,
    "-CAcreateserial", "-out", serverCertificate, "-days", "1", "-sha256",
    "-extfile", serverExtensions
  ]);
  runOpenSsl([
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2",
    "-keyout", untrustedKey, "-out", untrustedCertificate, "-subj", "/CN=Untrusted Decentracord TLS CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"
  ]);

  chmodSync(caKey, 0o600);
  chmodSync(serverKey, 0o600);
  chmodSync(untrustedKey, 0o600);
  chmodSync(caCertificate, 0o644);
  chmodSync(serverCertificate, 0o644);
  chmodSync(untrustedCertificate, 0o644);

  for (const file of [caKey, serverRequest, serverExtensions, untrustedKey]) {
    rmSync(file, { force: true });
  }
}

if (process.argv[2] !== "prepare") fail("INVALID_ARGUMENTS");

try {
  prepare(requiredDirectory(process.argv.slice(3)));
  process.stdout.write("Isolated TLS certificates prepared.\n");
} catch (error) {
  const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "TLS_FIXTURE_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
