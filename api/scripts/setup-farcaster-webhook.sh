#!/bin/bash
# Register Farcaster webhook with Neynar

if [ -z "$NEYNAR_API_KEY" ]; then
  echo "❌ NEYNAR_API_KEY not set"
  exit 1
fi

if [ -z "$WEBHOOK_URL" ]; then
  echo "❌ WEBHOOK_URL not set"
  echo "Example: export WEBHOOK_URL=https://your-domain.com/webhooks/neynar"
  exit 1
fi

if [ -z "$BOT_FID" ]; then
  echo "❌ BOT_FID not set"
  echo "Get your bot FID from https://hub.neynar.com/ or by running:"
  echo "  curl -X GET 'https://api.neynar.com/v2/farcaster/signer' \\"
  echo "    -H 'X-API-Key: \$NEYNAR_API_KEY'"
  exit 1
fi

echo "📝 Registering Farcaster webhook..."
echo "  URL: $WEBHOOK_URL"
echo "  Bot FID: $BOT_FID"
echo ""

curl -X POST "https://api.neynar.com/v2/webhooks/register" \
  -H "X-API-Key: $NEYNAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Liquid Launcher Bot\",
    \"url\": \"$WEBHOOK_URL\",
    \"events\": [
      {
        \"event\": \"cast.created\",
        \"filters\": {
          \"mentioned_fids\": [$BOT_FID]
        }
      }
    ]
  }" | jq .

echo ""
echo "✅ Webhook registered!"
echo "Save your webhook_id for future updates/deletion"
