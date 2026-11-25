#!/usr/bin/env node
// Criptografa/descriptografa backups do banco (AES-256-GCM com senha).
// Usado pelo workflow backup-offsite.yml, porque o repositório é público e
// os artifacts do GitHub precisam estar cifrados.
//
//   BACKUP_PASSPHRASE='sua-senha' node scripts/backup-crypto.js encrypt ilc.db ilc.db.enc
//   BACKUP_PASSPHRASE='sua-senha' node scripts/backup-crypto.js decrypt ilc.db.enc ilc.db
//
// Formato: "ILCBKP1" (7 bytes) + salt (16) + iv (12) + tag (16) + dados cifrados.

const crypto = require('crypto');
const fs = require('fs');

const MAGIC = Buffer.from('ILCBKP1');
const [mode, input, output] = process.argv.slice(2);
const passphrase = process.env.BACKUP_PASSPHRASE || '';

if (!['encrypt', 'decrypt'].includes(mode) || !input || !output) {
  console.error('Uso: BACKUP_PASSPHRASE=... node scripts/backup-crypto.js <encrypt|decrypt> <entrada> <saída>');
  process.exit(2);
}
if (passphrase.length < 16) {
  console.error('BACKUP_PASSPHRASE precisa ter pelo menos 16 caracteres.');
  process.exit(2);
}

const deriveKey = (salt) => crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const data = fs.readFileSync(input);

if (mode === 'encrypt') {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  fs.writeFileSync(output, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]));
} else {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) {
    console.error('Arquivo não é um backup cifrado do ILC.');
    process.exit(1);
  }
  let offset = MAGIC.length;
  const salt = data.subarray(offset, (offset += 16));
  const iv = data.subarray(offset, (offset += 12));
  const tag = data.subarray(offset, (offset += 16));
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
  decipher.setAuthTag(tag);
  try {
    fs.writeFileSync(output, Buffer.concat([decipher.update(data.subarray(offset)), decipher.final()]));
  } catch {
    console.error('Senha incorreta ou arquivo corrompido.');
    process.exit(1);
  }
}
console.log(`✅ ${mode === 'encrypt' ? 'Cifrado' : 'Decifrado'}: ${output}`);
