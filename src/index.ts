import { Router } from '@tsndr/cloudflare-worker-router'
import { google, Auth } from 'googleapis';
import * as jose from 'jose'

export interface Env {
    // oauth secrets
    CLIENT_ID: string;
    CLIENT_SECRET: string;

    // Input vars for the script
    ACCOUNT_ID: string;
    ACCOUNT_KEY: string; // needed?
    AUD_TAG: string;
    TEAM_DOMAIN: string;

    // Bindings
    PHOTO_BUCKET: R2Bucket;
}

const GOOGLE_PHOTOPICKER_URL = "https://photospicker.googleapis.com"
const REDIRECT_PATH = '/oauth_callback'

// router init and types
// Request Extension
export type ExtReq = {
    userId?: number
    url?: string
}
// Context Extension
export type ExtCtx = {
}
const router = new Router<Env, ExtCtx, ExtReq>()

// global middleware auth check
router.use( async ({ env, req }) => {

  // The Application Audience (AUD) tag for your application
  const CERTS_URL = `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`;

  const JWKS = jose.createRemoteJWKSet(new URL(CERTS_URL))
  const token = req.headers.get('cf-access-jwt-assertion')
  if (!token) {
    return new Response("Missing cf auth token", { status: 403 })
  }
  const result = await jose.jwtVerify(token, JWKS, {
    issuer: env.TEAM_DOMAIN,
    audience: env.AUD_TAG,
  })
  if (result.payload.aud != env.AUD_TAG) {
    return new Response("invalid jwt", {status: 403});
  }

})

// init google api client
function initOAuth2Client(env: Env, redirectURL: string): Auth.OAuth2Client {
  return new google.auth.OAuth2(env.CLIENT_ID, env.CLIENT_SECRET, redirectURL)
}

function getOAuthClientUrl(client: Auth.OAuth2Client): string {
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/photospicker.mediaitems.readonly'],
  })
}

router.get('/login', async ({env, req}) => {
  var baseURL = new URL(req.url)
  baseURL.pathname = REDIRECT_PATH
  var client = initOAuth2Client(env, baseURL.toString())
  // Redirect to google oauth login
  return Response.redirect(getOAuthClientUrl(client))
})


router.get(REDIRECT_PATH, async ({env, req, ctx}) => {

  // Get tokens
  var url = new URL(req.url)
  const searchParams = new URLSearchParams(url.search)
  const code = searchParams.get("code")
  // TODO null check better, throw if null inline
  if (!code) {
    throw new Error("Required code param not passed")
  }
  url.pathname = REDIRECT_PATH
  url.search = ""
  // TODO get host from env, not input

  const client = initOAuth2Client(env, url.toString());
  const {tokens} = await client.getToken(code)
    .catch((err) => {
      console.log("Unable to get google tokens: " + err)
      throw err;
    })

  // mksession, return picker URI redirect
  const response: PickerSessionResp =
    await fetch(`${GOOGLE_PHOTOPICKER_URL}/v1/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tokens.access_token
      },
    }).then((response) => {
      if (!response.ok) {
        console.log(`Error creating session: ${response.status}`);
        throw new Error(`Error creating session: ${response.status}`)
      } else {
        return response.json()
      }
    })

  // spawn poller using ctx.waitUntil
  // TODO
  // https://developers.cloudflare.com/workers/runtime-apis/context/
  ctx?.waitUntil(poller(response, tokens, env.PHOTO_BUCKET)) 

  // Return picker URI redirect
  return Response.redirect(response.pickerUri)

})

async function poller(
  sess: PickerSessionResp, tokens: Auth.Credentials, bucket: R2Bucket,
) {
  const resp: PickerSessionResp = await fetch(
    `${GOOGLE_PHOTOPICKER_URL}/v1/sessions/${sess.id}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tokens.access_token
      },
    }).then((response) => {
      if (!response.ok) {
        console.log(`Error fetching session: ${response.status}`);
        throw new Error(`Error fetching session: ${response.status}`)
      } else {
        return response.json()
      }
    })
  // User still picking, poll again
  if (!resp.mediaItemsSet) {
    // Wait until pollInterval set
    await new Promise(
      r => setTimeout(r, parseInt(resp.pollingConfig.pollInterval))
    );
    return poller(resp, tokens, bucket)
  }

  // User finished picking, run upload
  var mediaItems = await fetchImages(sess, null, tokens)
  return uploadImagesToCF(mediaItems, bucket, tokens)
}

interface PickerSessionResp  {
  id: string,
  pickerUri: string,
  pollingConfig: PollingConfig,
  expireTime: string,
  mediaItemsSet: boolean
}

interface PollingConfig {
  pollInterval: string,
  timeoutIn: string
}

async function fetchImages(
  sess:PickerSessionResp, pageToken:string | null, tokens: Auth.Credentials,
): Promise<PickedMediaItem[]> {
  var output = new Array<PickedMediaItem>
  var url = new URL(`${GOOGLE_PHOTOPICKER_URL}/v1/mediaItems`) 
  url.searchParams.set("sessionId", sess.id)
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken)
  }
  const resp: MediaItemsResp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tokens.access_token
      },
    }).then((response) => {
      if (!response.ok) {
        console.log(`Error fetching media items: ${response.status}`);
        throw new Error(`Error fetching media items: ${response.status}`)
      } else {
        return response.json()
      }
    })

  output.push(...resp.mediaItems)
  if (resp.nextPageToken) {
    var mediaItems = await fetchImages(sess, resp.nextPageToken, tokens)
    output.push(...mediaItems)
  }
  return output
}

interface MediaFile {
  baseUrl: string,
  mimeType: string,
  filename: string,
  //mediaFileMetadata": { object (MediaFileMetadata) }
}

enum MediaType {
  TYPE_UNSPECIFIED,
  PHOTO,
  VIDEO,
}

interface PickedMediaItem {
  id: string,
  createTime: string,
  type: MediaType,
  mediaFile: MediaFile,
}

interface MediaItemsResp {
  mediaItems: PickedMediaItem[],
  nextPageToken: string,
}

async function uploadImagesToCF(
  mediaItems: PickedMediaItem[], bucket: R2Bucket,
  tokens: Auth.Credentials,
) {

  // TODO strip exif info
  // https://github.com/joshbuddy/exif-be-gone
  // https://www.npmjs.com/package/exifr
  for (const mediaItem of mediaItems) {
    const image = await fetch(mediaItem.mediaFile.baseUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
      },
    });
    const bytes = await image.bytes();

    await bucket.put(mediaItem.mediaFile.filename, bytes);
  }
}

// Simple get
router.get('/user', () => {
    return Response.json({
        id: 1,
        name: 'John Doe'
    })
})
router.get('/mk_session', () => {

    return Response.json({
        id: 1,
        name: 'John Doe'
    })
})

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.handle(request, env, ctx)
  },
} satisfies ExportedHandler<Env>;
