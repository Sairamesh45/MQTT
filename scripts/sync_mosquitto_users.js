const { exec } = require('child_process');
const sequelize = require('../db');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

function deriveDevicePassword(imei, accessToken, length = 10) {
  const h = crypto.createHmac('sha256', accessToken).update(imei).digest('base64');
  const b64url = h.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64url.slice(0, length);
}

async function sync() {
  const mqttHost = process.env.MQTT_HOST || 'localhost';
  const mqttPort = process.env.MQTT_PORT || '1883';
  const adminUser = process.env.MOSQUITTO_ADMIN_USER;
  const adminPass = process.env.MOSQUITTO_ADMIN_PASS;
  const dynamicSecurityFile = path.resolve(process.env.DYNAMIC_SECURITY_FILE || 'dynamic-security.json');

  function mergeDynsecNewFile() {
    const newFile = dynamicSecurityFile + '.new';
    if (fs.existsSync(newFile)) {
      try {
        fs.copyFileSync(newFile, dynamicSecurityFile);
        fs.unlinkSync(newFile);
        console.log(`[DYNSEC] Merged ${path.basename(newFile)} into ${path.basename(dynamicSecurityFile)}`);
      } catch (err) {
        console.error('[DYNSEC] Failed to merge .new file:', err.message);
      }
    }
  }

  if (!adminUser || !adminPass) {
    console.error('MOSQUITTO_ADMIN_USER and MOSQUITTO_ADMIN_PASS must be set in environment');
    process.exit(1);
  }

  try {
    const [rows] = await sequelize.query('SELECT id, imei, access_token FROM device');
    for (const r of rows) {
      const imei = r.imei;
      let accessToken = r.access_token;
      if (!accessToken) {
        accessToken = crypto.randomBytes(32).toString('hex');
        // persist new access token to DB
        await sequelize.query('UPDATE device SET access_token = :accessToken WHERE id = :id', {
          replacements: { accessToken, id: r.id }
        });
        console.log(`Generated access_token for IMEI ${imei}`);
      }

      const password = deriveDevicePassword(imei, accessToken, 10);
      const deviceRole = `device_${imei}`;

      // delete existing client & role (ignore errors)
      try { await run(`mosquitto_ctrl -h ${mqttHost} -p ${mqttPort} -u ${adminUser} -P ${adminPass} dynsec deleteClient ${imei}`); } catch (e) {}
      try { await run(`mosquitto_ctrl -h ${mqttHost} -p ${mqttPort} -u ${adminUser} -P ${adminPass} dynsec deleteRole ${deviceRole}`); } catch (e) {}

      // create client
      await run(`mosquitto_ctrl -h ${mqttHost} -p ${mqttPort} -u ${adminUser} -P ${adminPass} dynsec createClient ${imei} -p ${password}`);
      console.log(`Created/updated client for ${imei}`);

      // assign shared deviceRole
      try { await run(`mosquitto_ctrl -h ${mqttHost} -p ${mqttPort} -u ${adminUser} -P ${adminPass} dynsec addClientRole ${imei} deviceRole`); } catch (e) { console.warn('addClientRole deviceRole failed', e.message); }

      // create per-device role and add subscribe ACLs
      await run(`mosquitto_ctrl -h ${mqttHost} -p ${mqttPort} -u ${adminUser} -P ${adminPass} dynsec createRole ${deviceRole}`);
      const subTopics = [
        `collar/${imei}/isOn`,
        `collar/${imei}/isWalking`,
        `collar/${imei}/isLost`,
        `collar/${imei}/ota/command`,
        'fleet/ota/command'
      ];
      for (const t of subTopics) {
        await run(`mosquitto_ctrl -h ${mqttHost} -p ${mqttPort} -u ${adminUser} -P ${adminPass} dynsec addRoleACL ${deviceRole} subscribeLiteral ${t} allow`);
      }

      // assign the per-device role to client
      await run(`mosquitto_ctrl -h ${mqttHost} -p ${mqttPort} -u ${adminUser} -P ${adminPass} dynsec addClientRole ${imei} ${deviceRole}`);
      console.log(`Assigned role ${deviceRole} to ${imei}`);
      // give Mosquitto a moment to flush .new then merge if needed (Windows fix)
      await new Promise((resolve) => setTimeout(resolve, 800));
      mergeDynsecNewFile();
    }

    console.log('Completed mosquitto sync');
    process.exit(0);
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(2);
  }
}

sync();
