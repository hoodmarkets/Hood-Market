# Supabase Image Upload Setup

Enable image uploads to Supabase Storage for persistent token images.

## Why Supabase?

- ✅ **Persistent Storage:** Images stored safely, not lost if URL dies
- ✅ **Auto-Optimized:** Images resized to 256x256 PNG (standard token size)
- ✅ **Public URLs:** Images accessible on-chain in token metadata
- ✅ **Fallback:** If upload fails, still deploys using original URL

## Setup Steps

### 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Sign up / Log in
3. Click **"New Project"**
4. Choose your region (closest to your users)
5. Wait for project to deploy (~2-3 minutes)

### 2. Create Storage Bucket

1. In Supabase dashboard, go to **Storage** (left sidebar)
2. Click **"New Bucket"**
3. Name: `token-images`
4. **Make it Public** (toggle "Public bucket" ON)
5. Click **"Create Bucket"**

### 3. Get API Keys

1. Go to **Settings** (gear icon, bottom left)
2. Click **"API"**
3. Copy these values:
   - **Project URL** → `SUPABASE_URL`
   - **Anon Public Key** → `SUPABASE_ANON_KEY`

### 4. Add Environment Variables to Railway

In Railway dashboard, add these variables:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_public_key_here
SUPABASE_BUCKET=token-images
```

### 5. Verify Setup

Test the connection:

```bash
curl -X OPTIONS https://your-project.supabase.co/storage/v1/object/token-images
# Should return 200 OK
```

## How It Works

### Image Upload Flow

```
User uploads image (URL or file)
        ↓
Supabase service receives image
        ↓
Sharp library resizes to 256x256 PNG
        ↓
Upload to Supabase storage
        ↓
Get public URL back
        ↓
Use public URL in token metadata
        ↓
Token deployed with persistent image ✅
```

### URL Handling

**If user provides URL:**
- Fetches the image from URL
- Resizes to 256x256 PNG
- Uploads to Supabase
- Returns Supabase public URL
- Falls back to original URL if upload fails

**If user provides buffer/base64:**
- Directly resizes and uploads
- Returns Supabase public URL

**If no image:**
- Token deploys without image (optional)

## Testing

### Test with Discord

1. Use `/deploy` command
2. Provide image URL: `https://example.com/token.png`
3. Bot will:
   - Fetch your image
   - Resize to 256x256
   - Upload to Supabase
   - Deploy with Supabase URL

Check in Supabase Storage → `token-images` bucket to see uploaded images.

### Verify Public URL

```bash
curl https://your-project.supabase.co/storage/v1/object/public/token-images/tokenname-1234567890.png
# Should return the image
```

## Security

- ✅ Anon key is **public** (safe to expose in frontend/env)
- ✅ Bucket is **public** (images meant to be viewable)
- ✅ No data is written to database
- ✅ Only image storage in Supabase (no user data)

If you want private images:
1. Toggle **"Public Bucket"** OFF in bucket settings
2. Use signed URLs instead
3. (Currently not implemented, but possible)

## Troubleshooting

### "Supabase not configured" warning?

- Check `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set in Railway
- Bot continues to work without Supabase (uses original URL)
- No errors, just uses fallback

### Images not uploading?

1. Verify bucket is **Public** in Supabase settings
2. Check SUPABASE_URL format: `https://xxxxx.supabase.co` (no trailing slash)
3. Check anon key is correct (copy-paste carefully)
4. Verify `token-images` bucket exists

### Image URL shows broken?

- Check image is uploaded in Supabase Storage dashboard
- Verify bucket permissions are Public
- Try direct URL: `https://your-project.supabase.co/storage/v1/object/public/token-images/filename.png`

### "Failed to fetch image" error?

- Original image URL might be broken or CORS-blocked
- Try downloading image manually first
- Use different image source

## Optional: Custom Bucket

To use a different bucket name:

```
SUPABASE_BUCKET=my-custom-bucket
```

Then create that bucket in Supabase Storage.

## Cost

Supabase free tier includes:
- **1 GB storage** (plenty for token images)
- **2 GB/month bandwidth**
- Totally free

Images are 256x256 PNG (~10-50 KB each):
- 1 GB = ~20,000-100,000 images
- Perfect for a launcher

## Next Steps

1. ✅ Create Supabase project
2. ✅ Create `token-images` bucket (public)
3. ✅ Copy API keys to Railway
4. ✅ Redeploy bot
5. ✅ Test with Discord deployment

Images will now persist on Supabase! 🎉

