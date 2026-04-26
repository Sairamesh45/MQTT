require('../logger');
const sequelize = require('../db');
const crypto = require('crypto');

(async () => {
  try {
    console.log('Starting password migration...');
    const [rows] = await sequelize.query('SELECT id, imei, access_token, password_hash FROM devices');
    for (const row of rows) {
      let { id, imei, access_token: accessToken, password_hash: existingHash } = row;
      let generated = false;
      if (!accessToken) {
        accessToken = crypto.randomBytes(32).toString('hex');
        generated = true;
      }

      // Derive deterministic 10-char password from imei + accessToken
      function deriveDevicePassword(imei, accessToken, length = 10) {
        const h = crypto.createHmac('sha256', accessToken).update(imei).digest('base64');
        const b64url = h.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return b64url.slice(0, length);
      }

      const mqttPassword = deriveDevicePassword(imei, accessToken, 10);
      const computedHash = crypto.createHash('sha256').update(mqttPassword).digest('hex');

      if (generated || existingHash !== computedHash) {
        await sequelize.query(
          `UPDATE devices SET access_token = :accessToken, password_hash = :passwordHash WHERE id = :id`,
          { replacements: { accessToken, passwordHash: computedHash, id } }
        );
        console.log(`Updated device id=${id} imei=${imei}`);
      } else {
        console.log(`Skipped device id=${id} imei=${imei} (no change)`);
      }
    }

    console.log('Password migration complete');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
})();
