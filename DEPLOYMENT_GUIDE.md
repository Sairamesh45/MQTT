# AWS Deployment Guide for MQTT Backend (EC2 Direct Deploy)

## ✅ Changes Applied

Your code has been updated with production-ready fixes:

1. ✅ **Environment variable validation** - App crashes early if required vars are missing
2. ✅ **SIGTERM handler** - Graceful shutdown for AWS
3. ✅ **Health check endpoint** - `/health` for ALB health checks
4. ✅ **Request body size limit** - 1MB limit to prevent DoS
5. ✅ **Production-ready host binding** - Listens on `0.0.0.0` by default

## 🚨 Architecture Overview

### Option 1: Single EC2 Instance (Development/Small deployments)

```
┌─────────────────────────────────┐
│       EC2 Instance (t3.medium)  │
│  ┌───────────────────────────┐  │
│  │   PM2 + Node.js Backend   │  │
│  │   (port 3000)             │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │   Mosquitto Broker        │  │
│  │   (port 1883)             │  │
│  └───────────────────────────┘  │
│                                 │
│  PostgreSQL: External (Neon)    │
└─────────────────────────────────┘
        ↑ Elastic IP (public access)
```

### Option 2: Separate Instances with ALB (Production)

```
        Internet
           ↓
    ┌─────────────┐
    │     ALB     │ (HTTPS/HTTP)
    │  (port 80)  │
    └──────┬──────┘
           │
    ┌──────▼──────┐
    │   EC2 #1    │ ────┐
    │   Backend   │     │     ┌──────────────┐
    │ (port 3000) │     ├────▶│  EC2         │
    └─────────────┘     │     │  Mosquitto   │
    ┌─────────────┐     │     │  (port 1883) │
    │   EC2 #2    │ ────┘     └──────────────┘
    │   Backend   │                     ↓
    │ (port 3000) │              dynamic-security.json
    └─────────────┘                  (on EBS)
```

## 📋 Deployment Steps

### Step 1: Launch EC2 Instance(s)

**For Single Instance (Development):**

- **Instance Type**: t3.medium (2 vCPU, 4GB RAM)
- **OS**: Ubuntu 22.04 LTS
- **Storage**: 20GB gp3 EBS
- **Network**: Public subnet with Elastic IP

**For Production (Backend Instance):**

- **Instance Type**: t3.small or larger
- **OS**: Ubuntu 22.04 LTS
- **Storage**: 10GB gp3 EBS
- **Network**: Private subnet (behind ALB)
- **Auto Scaling Group**: Optional (for high availability)

**Security Group for Backend:**

```
Inbound Rules:
- Port 3000 (TCP) from ALB security group (or 0.0.0.0/0 for single instance)
- Port 22 (TCP) from your IP (for SSH)

Outbound Rules:
- All traffic (for npm, database, MQTT broker)
```

**Security Group for Mosquitto Broker (if separate):**

```
Inbound Rules:
- Port 1883 (TCP) from Backend security group
- Port 22 (TCP) from your IP (for SSH)

Outbound Rules:
- All traffic
```

### Step 2: Install Node.js on Backend Instance

SSH into your EC2 instance:

```bash
ssh -i your-key.pem ubuntu@your-ec2-ip

# Update system
sudo apt-get update
sudo apt-get upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version  # Should show v20.x.x
npm --version

# Install PM2 for process management
sudo npm install -g pm2

# Install Mosquitto clients (for mosquitto_ctrl)
sudo apt-get install -y mosquitto-clients

# Install Git (to clone your repo)
sudo apt-get install -y git
```

### Step 3: Install Mosquitto Broker

**On the same instance (single instance setup):**

```bash
# Install Mosquitto and clients
sudo apt-get install -y mosquitto mosquitto-clients

# Stop Mosquitto (we'll configure it first)
sudo systemctl stop mosquitto

# Create directory for dynamic security
sudo mkdir -p /etc/mosquitto/dynsec
```

**On a separate instance (production setup):**

```bash
# SSH to Mosquitto instance
ssh -i your-key.pem ubuntu@mosquitto-ec2-ip

# Install Mosquitto
sudo apt-get update
sudo apt-get install -y mosquitto mosquitto-clients

# Stop Mosquitto
sudo systemctl stop mosquitto

# Create directory for dynamic security
sudo mkdir -p /etc/mosquitto/dynsec
```

### Step 4: Configure Mosquitto

**Create or edit** `/etc/mosquitto/mosquitto.conf`:

```conf
listener 1883
allow_anonymous false

# Dynamic security plugin
plugin /usr/lib/mosquitto_dynamic_security.so
plugin_opt_config_file /etc/mosquitto/dynsec/dynamic-security.json

# Logging
log_dest file /var/log/mosquitto/mosquitto.log
log_type all
log_timestamp true
```

**Copy your dynamic-security.json:**

```bash
# On your local machine, upload the file
scp -i your-key.pem dynamic-security.json ubuntu@mosquitto-ec2-ip:/tmp/

# On the Mosquitto instance
ssh -i your-key.pem ubuntu@mosquitto-ec2-ip
sudo mv /tmp/dynamic-security.json /etc/mosquitto/dynsec/
sudo chown mosquitto:mosquitto /etc/mosquitto/dynsec/dynamic-security.json
sudo chmod 600 /etc/mosquitto/dynsec/dynamic-security.json

# Start Mosquitto
sudo systemctl start mosquitto
sudo systemctl enable mosquitto

# Check status
sudo systemctl status mosquitto
```

### Step 5: Deploy Backend Application

**Clone your repository:**

```bash
# SSH to backend instance
ssh -i your-key.pem ubuntu@backend-ec2-ip

# Create application directory
mkdir -p ~/mqtt-backend
cd ~/mqtt-backend

# Clone your code (or upload via SCP)
# Option A: Git clone
git clone https://github.com/your-repo/mqtt-backend.git .

# Option B: Upload from local
# (on your local machine)
# scp -i your-key.pem -r . ubuntu@backend-ec2-ip:~/mqtt-backend/
```

**Install dependencies:**

```bash
cd ~/mqtt-backend
npm install --production
```

**Create .env file:**

```bash
nano .env
```

Add your environment variables:

```env
# Database
NEON_DB_URL=postgresql://user:pass@host.region.neon.tech:5432/db?sslmode=require

# MQTT Broker
MQTT_HOST=localhost  # or private IP of Mosquitto instance
MQTT_PORT=1883
MQTT_USERNAME=admin
MQTT_PASSWORD=your-secure-password

# Mosquitto Dynamic Security
MOSQUITTO_ADMIN_USER=admin1
MOSQUITTO_ADMIN_PASS=your-admin-password
DYNAMIC_SECURITY_FILE=/etc/mosquitto/dynsec/dynamic-security.json

# Application
PORT=3000
API_HOST=0.0.0.0

# External App API
APP_API_URL=http://your-app-domain.com/isLost
DUMMY_APP_HOST=localhost
DUMMY_APP_PORT=3001
```

**Secure the .env file:**

```bash
chmod 600 .env
```

### Step 6: Run with PM2

**Create PM2 ecosystem file:**

```bash
nano ecosystem.config.js
```

```javascript
module.exports = {
  apps: [
    {
      name: "mqtt-backend",
      script: "./index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time: true,
    },
  ],
};
```

**Start the application:**

```bash
# Create logs directory
mkdir -p logs

# Start with PM2
pm2 start ecosystem.config.js

# Check status
pm2 status

# View logs
pm2 logs mqtt-backend

# Save PM2 process list
pm2 save

# Setup PM2 to start on system boot
pm2 startup
# Follow the instructions output by the command
```

### Step 7: Setup Nginx (Optional - Recommended for SSL)

```bash
# Launch t3.small EC2 in private subnet
# Install Mosquitto
sudo apt-get update
sudo apt-get install mosquitto mosquitto-clients

# Copy your mosquitto.conf and dynamic-security.json
# Start Mosquitto
sudo systemctl start mosquitto
sudo systemctl enable mosquitto
```

**Security Group:** Allow port 1883 from ECS security group only

### Step 2: Create AWS Secrets

````bash
# Store sensitive credentials in Secrets Manager
aws secretsmanager create-secret \
  --name mqtt-backend/db-url \
  --secret-string "postgresql://user:pass@host:5432/db?sslmode=require"

aws secretsmanager create-secret \
  --name mqtt-backend/mqtt-username \
  --secret-string "admin"

aws secretsmanager create-secret \
  --name mqtt-backend/mqtt-password \
### Step 7: Setup Nginx (Optional - Recommended for SSL)

If using a single EC2 instance with Elastic IP, use Nginx as reverse proxy:

```bash
# Install Nginx
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Create Nginx configuration
sudo nano /etc/nginx/sites-available/mqtt-backend
````

Add this configuration:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_read_timeout 86400;
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/mqtt-backend /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx

# Setup SSL (optional but recommended)
sudo certbot --nginx -d your-domain.com

# Certbot will automatically configure SSL

```

### Step 8: (Optional) Setup Application Load Balancer for Production

If using multiple backend instances for high availability:

```bash
# Create ALB
aws elbv2 create-load-balancer \
  --name mqtt-backend-alb \
  --subnets subnet-xxx subnet-yyy \
  --security-groups sg-xxx \
  --scheme internet-facing

# Create target group
aws elbv2 create-target-group \
  --name mqtt-backend-tg \
  --protocol HTTP \
  --port 3000 \
  --vpc-id vpc-xxx \
  --target-type instance \
  --health-check-path /health \
  --health-check-interval-seconds 30

# Register instances
aws elbv2 register-targets \
  --target-group-arn arn:aws:... \
  --targets Id=i-instance1 Id=i-instance2

# Create listener
aws elbv2 create-listener \
  --load-balancer-arn arn:aws:... \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=forward,TargetGroupArn=arn:aws:...
```

## 🧪 Testing Deployment

### 1. Test Health Endpoint

```bash
# Single instance with Elastic IP
curl http://your-elastic-ip:3000/health

# With Nginx
curl http://your-domain.com/health

# With ALB
curl http://your-alb-dns.region.elb.amazonaws.com/health
```

Expected response:

```json
{
  "uptime": 123.456,
  "timestamp": 1234567890,
  "status": "ok",
  "mqtt": "connected",
  "database": "connected"
}
```

### 2. Test Device Registration

```bash
curl -X POST http://your-domain.com/imei \
  -H "Content-Type: application/json" \
  -d '{"imei": "123456789012345"}'
```

### 3. Check Application Logs

```bash
# PM2 logs
pm2 logs mqtt-backend

# View last 100 lines
pm2 logs mqtt-backend --lines 100

# Follow logs in real-time
pm2 logs mqtt-backend --lines 0
```

### 4. Check Mosquitto Logs

```bash
sudo tail -f /var/log/mosquitto/mosquitto.log
```

### 5. Test MQTT Connection

```bash
# Subscribe to test topic (on broker instance)
mosquitto_sub -h localhost -p 1883 -u admin -P your-password -t 'test/#' -v

# Publish test message (from another terminal)
mosquitto_pub -h localhost -p 1883 -u admin -P your-password -t 'test/hello' -m 'Hello MQTT'
```

## 🔍 Monitoring & Management

### PM2 Commands

```bash
# View all processes
pm2 list

# Monitor CPU/Memory
pm2 monit

# Monitor CPU/Memory
pm2 monit

# Restart application
pm2 restart mqtt-backend

# Stop application
pm2 stop mqtt-backend

# View process details
pm2 show mqtt-backend

# Clear logs
pm2 flush

# Update application (after code changes)
cd ~/mqtt-backend
git pull  # or upload new files
npm install --production
pm2 restart mqtt-backend
```

### System Monitoring

```bash
# Check CPU and memory
htop

# Check disk space
df -h

# Check network connections
netstat -tulpn | grep :3000
netstat -tulpn | grep :1883

# Check system logs
sudo journalctl -u mosquitto -f
```

### CloudWatch Monitoring (Optional)

Install CloudWatch agent for metrics and logs:

```bash
# Download CloudWatch agent
wget https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb

# Install
sudo dpkg -i amazon-cloudwatch-agent.deb

# Configure (requires IAM role with CloudWatch permissions)
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-config-wizard
```

## 🔍 Troubleshooting

### Application Not Starting

```bash
# Check PM2 logs
pm2 logs mqtt-backend --err

# Common issues:
# 1. Missing environment variables
cat .env

# 2. Can't connect to database
node -e "const {Sequelize} = require('sequelize'); new Sequelize(process.env.NEON_DB_URL).authenticate().then(() => console.log('DB OK')).catch(e => console.error('DB ERROR:', e.message));"

# 3. Can't connect to MQTT broker
mosquitto_pub -h localhost -p 1883 -u admin -P your-password -t test -m test
```

### Mosquitto Not Working

```bash
# Check Mosquitto status
sudo systemctl status mosquitto

# Check Mosquitto logs
sudo tail -100 /var/log/mosquitto/mosquitto.log

# Test authentication
mosquitto_pub -h localhost -p 1883 -u admin -P wrong-password -t test -m test
# Should fail with authentication error

# Check dynamic-security.json permissions
ls -la /etc/mosquitto/dynsec/dynamic-security.json
# Should be owned by mosquitto:mosquitto with 600 permissions
```

### High Memory Usage

```bash
# Check memory usage
free -h

# Check which process is using memory
sudo ps aux --sort=-%mem | head -n 10

# Restart PM2 if needed
pm2 restart mqtt-backend

# Set memory limit in ecosystem.config.js
# max_memory_restart: '500M'
```

### Can't Access from Internet

```bash
# Check if app is listening
sudo netstat -tulpn | grep :3000

# Check security group
# Ensure inbound rule allows port 3000 (or 80 if using Nginx)

# Check firewall (if enabled)
sudo ufw status
sudo ufw allow 3000  # if needed

# Check Nginx (if using)
sudo systemctl status nginx
sudo nginx -t
```

## 💰 Cost Estimation (us-east-1)

### Single Instance Setup (Development):

- EC2 t3.medium (24/7): ~$30/month
- EBS 20GB gp3: ~$2/month
- Elastic IP: Free (when attached)
- Data transfer: ~$5-10/month
- **Total: ~$37-42/month**

### Production Setup with ALB:

- EC2 t3.small x 2 (24/7): ~$30/month
- EC2 t3.small (Mosquitto): ~$15/month
- Application Load Balancer: ~$16/month
- EBS volumes: ~$3/month
- Data transfer: ~$10-20/month
- **Total: ~$74-84/month**

### Cost Optimization:

- Use Reserved Instances (save 40-60%)
- Use Savings Plans
- Stop dev instances when not in use
- Use t3.micro for dev/testing (~$7.50/month)

## 🔐 Security Checklist

- [ ] SSH key pairs stored securely (not committed to git)
- [ ] Security groups follow least privilege (no 0.0.0.0/0 for production)
- [ ] .env file permissions set to 600
- [ ] Mosquitto uses authentication (no anonymous access)
- [ ] Database connection uses SSL (sslmode=require)
- [ ] Nginx SSL certificate configured (Let's Encrypt)
- [ ] Regular system updates scheduled
- [ ] CloudWatch alarms configured
- [ ] Backup strategy for dynamic-security.json
- [ ] IAM roles used (not IAM users with access keys)
- [ ] Enable AWS CloudTrail for audit logs
- [ ] Regular password rotation (90 days)

## 🔄 Updates and Maintenance

### Update Application Code

```bash
# SSH to instance
ssh -i your-key.pem ubuntu@your-ec2-ip

# Navigate to app directory
cd ~/mqtt-backend

# Pull latest code
git pull

# Install any new dependencies
npm install --production

# Restart application
pm2 restart mqtt-backend

# Check logs
pm2 logs mqtt-backend --lines 50
```

### Update System Packages

```bash
# Update package list
sudo apt-get update

# Upgrade packages
sudo apt-get upgrade -y

# Reboot if kernel was updated
sudo reboot

# After reboot, check PM2
pm2 save
pm2 resurrect
```

### Backup Strategy

**Backup dynamic-security.json:**

```bash
# Create backup script
nano ~/backup-dynsec.sh
```

```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
sudo cp /etc/mosquitto/dynsec/dynamic-security.json \
     ~/backups/dynamic-security-${DATE}.json
# Keep only last 30 backups
ls -t ~/backups/dynamic-security-*.json | tail -n +31 | xargs rm -f
```

```bash
chmod +x ~/backup-dynsec.sh

# Add to crontab (daily at 2 AM)
crontab -e
# Add line:
0 2 * * * /home/ubuntu/backup-dynsec.sh
```

**Backup to S3 (recommended):**

```bash
# Install AWS CLI
sudo apt-get install -y awscli

# Create S3 bucket (one-time)
aws s3 mb s3://your-mqtt-backup-bucket

# Backup script with S3
nano ~/backup-to-s3.sh
```

```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/dynamic-security-${DATE}.json"
sudo cp /etc/mosquitto/dynsec/dynamic-security.json ${BACKUP_FILE}
aws s3 cp ${BACKUP_FILE} s3://your-mqtt-backup-bucket/dynsec/
rm ${BACKUP_FILE}
```

## 📞 Next Steps

1. **Test everything locally first**
2. **Deploy to a dev/staging instance** before production
3. **Set up CloudWatch alarms:**
   - High CPU usage (>80%)
   - High memory usage (>80%)
   - Disk space low (<10%)
   - Application down (health check failing)

4. **Document your specific configuration** (IP addresses, domain names, etc.)
5. **Create a disaster recovery plan**
6. **Schedule regular maintenance windows**

## 📚 Additional Resources

- [PM2 Documentation](https://pm2.keymetrics.io/docs/usage/quick-start/)
- [Mosquitto Documentation](https://mosquitto.org/documentation/)
- [Nginx Documentation](https://nginx.org/en/docs/)
- [AWS EC2 User Guide](https://docs.aws.amazon.com/ec2/)
- [Let's Encrypt - Certbot](https://certbot.eff.org/)

---

**Your application is now ready for EC2 deployment! 🚀**
