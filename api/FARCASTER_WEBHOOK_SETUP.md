# Farcaster Webhook Setup Guide

## Overview
The Liquid Launcher bot listens for mentions on Farcaster via Neynar webhooks. When someone mentions `@liquidlauncher`, the bot receives the cast and can respond with deployments.

## Prerequisites
- ✅ Neynar API key (already in `NEYNAR_API_KEY` env var)
- ✅ Neynar signer UUID (already in `NEYNAR_SIGNER_UUID` env var)
- ✅ Your app must be publicly accessible (not localhost)

## Step 1: Get Your Farcaster Bot FID

Your signer UUID creates a Farcaster account. To find its FID:

```bash
curl -X GET "https://api.neynar.com/v2/farcaster/signer" \
  -H "X-API-Key: YOUR_NEYNAR_API_KEY" \
  -H "Content-Type: application/json"
```

Look for `fid` in the response. Example output:
```json
{
  "signer": {
    "uuid": "YOUR_SIGNER_UUID",
    "public_key": "...",
    "signer_uuid": "...",
    "fid": 123456
  }
}
```

Or check your Neynar dashboard at https://hub.neynar.com/

Save this FID for the next step.

## Step 2: Register Webhook with Neynar

Use the Neynar API to register a webhook that listens for casts mentioning your bot:

```bash
curl -X POST "https://api.neynar.com/v2/webhooks/register" \
  -H "X-API-Key: YOUR_NEYNAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Liquid Launcher Bot",
    "url": "https://your-domain.com/webhooks/neynar",
    "events": [
      {
        "event": "cast.created",
        "filters": {
          "mentioned_fids": [123456]
        }
      }
    ]
  }'
```

**Replace:**
- `YOUR_NEYNAR_API_KEY` - Your actual Neynar API key
- `https://your-domain.com` - Your public domain/IP
- `123456` - Your bot's FID from Step 1

**Response:**
```json
{
  "webhook_id": "abc123",
  "name": "Liquid Launcher Bot",
  "url": "https://your-domain.com/webhooks/neynar",
  "is_active": true,
  "created_at": "2026-04-09T23:00:00.000Z"
}
```

Save the `webhook_id` for management.

## Step 3: Test the Webhook

1. **Make sure your app is running:**
   ```bash
   npm run build
   npm start
   ```

2. **Check health endpoint:**
   ```bash
   curl https://your-domain.com/
   ```

   Should return:
   ```json
   {
     "status": "ok",
     "service": "liquid-social-launcher",
     "platforms": {
       "farcaster": true
     }
   }
   ```

3. **Mention the bot on Farcaster:**
   - Go to Farcaster (warpcast.com)
   - Create a new cast mentioning `@liquidlauncher deploy test`
   - Wait 2-5 seconds

4. **Check logs:**
   ```bash
   # If running locally:
   npm start
   
   # Should show:
   # Farcaster webhook received: { type: 'cast.created' }
   # Processing cast: { author: 'yourname', text: '@liquidlauncher deploy test', hash: '...' }
   ```

## Step 4: List Existing Webhooks

To see all your registered webhooks:

```bash
curl -X GET "https://api.neynar.com/v2/webhooks/list" \
  -H "X-API-Key: YOUR_NEYNAR_API_KEY" \
  -H "Content-Type: application/json"
```

## Step 5: Update or Delete Webhooks

**Update webhook URL (if your domain changes):**
```bash
curl -X PATCH "https://api.neynar.com/v2/webhooks/abc123" \
  -H "X-API-Key: YOUR_NEYNAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://new-domain.com/webhooks/neynar"
  }'
```

**Delete webhook:**
```bash
curl -X DELETE "https://api.neynar.com/v2/webhooks/abc123" \
  -H "X-API-Key: YOUR_NEYNAR_API_KEY"
```

## Troubleshooting

### Bot not responding?

1. **Check if webhook is registered:**
   ```bash
   curl https://api.neynar.com/v2/webhooks/list \
     -H "X-API-Key: YOUR_NEYNAR_API_KEY"
   ```

2. **Verify your domain is public:**
   ```bash
   curl https://your-domain.com/
   ```
   Should NOT return connection refused

3. **Check server logs:**
   - Look for `Farcaster webhook received` messages
   - Check for errors in `/webhooks/neynar` endpoint

4. **Verify FID is correct:**
   - Make sure you used your bot's FID (not your personal FID)
   - Get it from Neynar dashboard or API

5. **Check cast format:**
   - Message must mention `@liquidlauncher`
   - Webhook will only trigger if the bot FID is in `mentioned_fids`

### Webhook timeout?

- Neynar expects a response within 5 seconds
- Make sure your `/webhooks/neynar` endpoint responds quickly
- Heavy deployments might timeout—consider async processing

## Environment Variables

Make sure these are set in Railway/Docker:

```
NEYNAR_API_KEY=your_api_key
NEYNAR_SIGNER_UUID=your_signer_uuid
NEYNAR_WEBHOOK_SECRET=optional_secret
```

## Production Deployment

When deploying to Railway:

1. Set `BASE_URL` or domain environment variable
2. Update webhook URL to point to your Railway domain
3. Ensure HTTPS is enabled
4. Test webhook after deployment

## Webhook Event Reference

**Event:** `cast.created`  
**Filters:**
- `mentioned_fids`: [array of FIDs] - Only trigger when these users are mentioned
- `author_fids`: [array of FIDs] - Only trigger when these users create casts

Example - listen for mentions + specific author:
```json
{
  "event": "cast.created",
  "filters": {
    "mentioned_fids": [123456],
    "author_fids": [789012]
  }
}
```

## Support

- Neynar Docs: https://docs.neynar.com/
- Neynar Dashboard: https://hub.neynar.com/
- Webhook Status: Check your Neynar dashboard → Webhooks section

