# Railway Webhook URL Setup

## Get Your Railway Domain

Railway automatically assigns a public domain to your deployed service. Here's how to find it:

### Method 1: Railway Dashboard

1. Go to [railway.app](https://railway.app)
2. Log in and navigate to your project
3. Click on your **Liquid Launcher service**
4. Go to the **Settings** tab
5. Look for **"Domain"** section
6. You should see a URL like: `https://liquid-launcher-production.up.railway.app`

### Method 2: Environment Variables

Railway exposes the domain via environment variables. Add these to your service:

1. In Railway dashboard, go to **Variables**
2. You'll see `RAILWAY_PUBLIC_DOMAIN` (if public domain is enabled)

Or in your code:
```typescript
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_ENVIRONMENT_DOMAIN;
```

### Method 3: CLI

If you have Railway CLI installed:

```bash
railway status
```

This shows your service info including the public URL.

## Enable Public URL in Railway

If your service doesn't have a public URL:

1. Go to **Settings** tab
2. Scroll to **"Networking"** section  
3. Toggle **"Public Networking"** ON
4. A domain will be assigned automatically

Format: `https://<project-slug>.up.railway.app`

## Use Railway URL for Webhooks

Once you have your Railway domain:

### For Farcaster Webhook

```bash
export WEBHOOK_URL="https://your-railway-domain.up.railway.app/webhooks/neynar"
export NEYNAR_API_KEY="your_key"
export BOT_FID="your_fid"

./scripts/setup-farcaster-webhook.sh
```

### For X Webhook (if using webhooks)

In Railway environment variables:
```
X_WEBHOOK_URL=https://your-railway-domain.up.railway.app/webhooks/x
```

## Test Your Webhook URL

Verify the domain is working:

```bash
curl https://your-railway-domain.up.railway.app/

# Should return:
# {
#   "status": "ok",
#   "service": "liquid-social-launcher",
#   "platforms": { ... }
# }
```

## Environment Variables in Railway

Add to your Railway service:

| Variable | Value |
|----------|-------|
| `NEYNAR_WEBHOOK_SECRET` | (optional) Secret key for Neynar |
| `BASE_URL` | `https://your-railway-domain.up.railway.app` |

The `BASE_URL` can be used in your app for dynamic webhook URLs.

## Railway Domain Auto-Configuration

To automatically use Railway's domain in your app:

```typescript
// In src/index.ts or config
const webhookUrl = process.env.BASE_URL || 
                   process.env.RAILWAY_PUBLIC_DOMAIN ||
                   `http://localhost:${config.port}`;

logger.info(`Webhook URL: ${webhookUrl}/webhooks/neynar`);
```

## Custom Domain (Optional)

If you want a custom domain:

1. Go to **Settings** → **Domain**
2. Click **"Add Custom Domain"**
3. Enter your domain (e.g., `bot.yourcompany.com`)
4. Update DNS records as instructed
5. Railway provisions SSL certificate automatically

## Troubleshooting

### Domain not showing?

- Make sure **Public Networking** is enabled in Settings
- Check that the service has finished deploying
- Try refreshing the Railway dashboard

### Webhook not receiving events?

1. Verify the domain is accessible:
   ```bash
   curl https://your-domain.up.railway.app/
   ```

2. Check server logs in Railway dashboard
3. Verify webhook is registered correctly with Neynar
4. Make sure your service is running (not in stopped state)

### SSL Certificate Issue?

Railway automatically provisions free SSL certificates. If you see SSL errors:
- Wait 5-10 minutes after deploying
- Clear browser cache
- Try accessing with `curl -v`

## Speed Up Webhook Testing

When testing locally before deploying:

1. Use a tunneling service like **ngrok**:
   ```bash
   ngrok http 8080
   ```
   This gives you a public URL for local testing

2. Or deploy to Railway first, then register webhooks

## Summary

**Your webhook URL format:**
```
https://<your-railway-project>.up.railway.app/webhooks/neynar
```

Use this in the Farcaster webhook registration:
```bash
export WEBHOOK_URL="https://your-railway-domain.up.railway.app/webhooks/neynar"
./scripts/setup-farcaster-webhook.sh
```

Done! Your bot will now listen for Farcaster mentions. 🚀
