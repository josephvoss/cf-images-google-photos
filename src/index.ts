import { Router } from '@tsndr/cloudflare-worker-router'
import { google, Auth } from 'googleapis';
import * as jose from 'jose'

// TODO
// [?] Fix recursion in poller
// [x] fetch full sized images
// [?] set exif metadata to download
// [ ] how to handle motion pictures
// [ ] err check or something in main resp page
//     open picker in new tab?

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
    ASSETS: Fetcher;
    SESSION_KV: KVNamespace;
}

const GOOGLE_PHOTOPICKER_URL = "https://photospicker.googleapis.com"
const REDIRECT_PATH = '/oauth_callback'
const CF_JWT_HEADER = 'cf-access-jwt-assertion'

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

async function checkJWTHeaders(env: Env, headers: Headers): Promise<jose.JWTPayload>{
  const token = headers.get(CF_JWT_HEADER)
  if (!token) {
    throw new Error("Missing cf auth token")
  }
  const JWKS = jose.createRemoteJWKSet(new URL(
    `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`,
  ))
  const result = await jose.jwtVerify(token, JWKS, {
    issuer: env.TEAM_DOMAIN,
    audience: env.AUD_TAG,
  })

  return result.payload
}

// global middleware auth check
router.use( ({ env, req }) => {
  return checkJWTHeaders(env, req.headers)
    .then( (payload) => {
      if (payload.aud != env.AUD_TAG) {
        return new Response("middleware: invalid jwt", {status: 403});
      }
    }).catch((err) => {
      return new Response(`middleware: unable to check jwt: ${err}`,
        {status: 403},
      );
    })
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

  // Get user name
  const payload = await checkJWTHeaders(env, req.headers)
  if ((!payload) || (!payload.sub)) {
    console.log(`Unable to fetch user from jwt`)
    throw new Error(`unable to fetch user from jwt`)
  }

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
  ctx?.waitUntil(poller(response, tokens, payload.sub, env)) 

  // Return picker URI redirect
  return Response.redirect(response.pickerUri)

})

async function poller(
  sess: PickerSessionResp, tokens: Auth.Credentials, user: string, env: Env,
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
    // TODO add date, I'm not convinced this is correct
    const sessionStatus = {
      user: user,
      text: "Waiting for photo picker to complete",
      finished: false,
      retry: false,
    }
    console.log(`recursing in poller. Poll int: ${resp.pollingConfig.pollInterval}`)
    await updateSessionStatus(env, sessionStatus)
    // waiting on session
    return await new Promise(
      // seconds to ms
      r => setTimeout(r, parseInt(resp.pollingConfig.pollInterval) * 1000)
      // This is hacky and I don't understand promises
    ).then(async () => { await poller(resp, tokens, user, env) })
  }

  // User finished picking, run upload
  var mediaItems = await fetchImages(sess, null, tokens, user, env)
  return uploadImagesToCF(mediaItems, tokens, user, env)
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
  sess:PickerSessionResp,
  pageToken:string | null,
  tokens: Auth.Credentials,
  user: string,
  env: Env,
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
    console.log("recursing fetchimage")
    var mediaItems = await fetchImages(sess, resp.nextPageToken, tokens, user, env)
    output.push(...mediaItems)
  }
  return output
}

interface MediaFile {
  baseUrl: string,
  mimeType: string,
  filename: string,
  mediaFileMetadata: { width: number, height: number }
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
  mediaItems: PickedMediaItem[],
  tokens: Auth.Credentials,
  user: string,
  env: Env
) {

  // TODO strip exif info - needed anymore?
  // https://github.com/joshbuddy/exif-be-gone
  // https://www.npmjs.com/package/exifr
  for (const mediaItem of mediaItems) {
    const {width, height} = mediaItem.mediaFile.mediaFileMetadata
    const sessionStatus = {
      user: user,
      text: `Fetching image ${mediaItem.mediaFile.filename}`,
      finished: false,
      retry: false,
    }
    await updateSessionStatus(env, sessionStatus)
    const image = await fetch(
      mediaItem.mediaFile.baseUrl + `=w${width}-h${height}-d`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
      },
    });
    const bytes = await image.bytes();

    await env.PHOTO_BUCKET.put(mediaItem.mediaFile.filename, bytes);
  }
  console.log("finished fetching all images") 
}

// Custom type for updating session
interface SessionStatus {
  user: string,
  text: string,
  finished: boolean,
  retry: boolean, //?
}

async function updateSessionStatus(
  env: Env, status: SessionStatus,
) {
  console.log(`Will set status: ${status}`)
  await env.SESSION_KV.put(status.user, JSON.stringify(status))
}

router.get('/check_status', async ({req, env}) => {
  const payload = await checkJWTHeaders(env, req.headers)
  if (!payload.sub) {
    return new Response("JWT doens't contain sub", { status: 403 })
  }

  // could use `cf-access-authenticated-user-email` instead of jwt sub if I care
  const status: SessionStatus | null = await env.SESSION_KV.get(payload.sub, "json")
  if (!status) {
    return new Response(
      "No session exists for user", {
        status: 404,
      }
    )
  }

  if (status.finished) {
    await env.SESSION_KV.delete(payload.sub)
  }

  return Response.json(status)
})

// Simple get
router.get('/', ({req, env}) => {
  // Login
  var baseURL = new URL(req.url)
  baseURL.pathname = REDIRECT_PATH
  var client = initOAuth2Client(env, baseURL.toString())

  // Open new tab to google oauth login
  // TODO to get session token, need to get data from redirect
  // read-write to KV?
  // need script in site to query kv for session status
  /*
  return new Response(`<!DOCTYPE html>
<body>
  <a target="_blank" rel="noopener noreferrer" href=${getOAuthClientUrl(client)}>Upload</a>
</body>`, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
    },
  })
 */
  return env.ASSETS.fetch('index.html')
})


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.handle(request, env, ctx)
  },
} satisfies ExportedHandler<Env>;
