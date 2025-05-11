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
  ASSETS: Fetcher;
  SESSION_KV: KVNamespace;
}

const GOOGLE_PHOTOPICKER_URL = "https://photospicker.googleapis.com"
const REDIRECT_PATH = '/oauth_callback'
const CF_JWT_HEADER = 'cf-access-jwt-assertion'
const SESSION_PREFIX = 'sessions'
const STATUS_PREFIX = 'status_text'

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

interface MediaItemsResp {
  mediaItems: PickedMediaItem[],
  nextPageToken: string,
}

interface PickedMediaItem {
  id: string,
  createTime: string,
  type: MediaType,
  mediaFile: MediaFile,
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

// Custom type for updating session
interface SessionStatus {
  user: string,
  text: string,
  finished: boolean,
  retry: boolean, //?
}

interface KVSessionSet {
  pickerSessionId: string,
  pickerSessionComplete: boolean,
  // Don't bother with refresh, if this takes more than an hour we have a problem
  token: string,
  user: string,
  mediaItems: PickedMediaItem[]
}

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

  // Upload session info
  await updateSessionKV({
    pickerSessionId: response.id,
    pickerSessionComplete: false,
    token: tokens.access_token!,
    user: payload.sub,
    mediaItems: [],
  }, env)

  // Return picker URI redirect
  return Response.redirect(response.pickerUri)

})

async function handleKVSessionSet(
   kvSess: KVSessionSet, env: Env,
) {
  var resp = await getPickerSession(
    kvSess.pickerSessionId, kvSess.token, kvSess.user, env,
  )
  // if sess is not finished, exit early
  if (!resp.mediaItemsSet) {
    console.log(`Waiting in poller: ${new Date().toISOString()}`)
    const sessionStatus = {
      user: kvSess.user,
      text: "Waiting for photo picker to complete",
      finished: false,
      retry: false,
    }
    await updateSessionStatus(env, sessionStatus)
    return 
  }

  if (!kvSess.pickerSessionComplete) {
    // Session complete but KV doesn't think so
    // update KV
    kvSess.pickerSessionComplete = resp.mediaItemsSet
    await updateSessionKV(kvSess, env)
  }

  // if media isn't set in KV, fetch and save
  if (kvSess.mediaItems.length == 0) {
    kvSess.mediaItems = await fetchImages(resp, null, kvSess.token, kvSess.user, env)
    await updateSessionKV(kvSess, env)
  }

  while (kvSess.mediaItems.length > 0) {
    const media = kvSess.mediaItems.pop()
    if (!media) {
      throw new Error("Trying to pop media returned err?")
    }
    await uploadImageToCF(media, kvSess.token, kvSess.user, env)
    await updateSessionKV(kvSess, env)
  }

  // Delete KV if we made it this far (unlikely?)
  console.log(`Removing session for ${kvSess.user}`)
  await env.SESSION_KV.delete(`${SESSION_PREFIX}/${kvSess.user}`)
}

async function updateSessionKV(kvSess: KVSessionSet, env: Env) {
  console.log(`Updating session KV: ${JSON.stringify(kvSess)}`)
  await env.SESSION_KV.put(
    `${SESSION_PREFIX}/${kvSess.user}`,
    JSON.stringify(kvSess),
  ).catch( (err) => {
    console.log(`Unable to update kv sess: ${err}`)
    throw err
  })
}

function getPickerSession(
  sessId: string, token: string, user: string, env: Env,
): Promise<PickerSessionResp> {
  return fetch(
    `${GOOGLE_PHOTOPICKER_URL}/v1/sessions/${sessId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
    }).then((response) => {
      if (!response.ok) {
        console.log(`Error fetching session: ${response.status}`);
        throw new Error(`Error fetching session: ${response.status}`)
      } else {
        return response.json()
      }
    })
}

async function fetchImages(
  sess:PickerSessionResp,
  pageToken:string | null,
  token: string,
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
        'Authorization': 'Bearer ' + token
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
    var mediaItems = await fetchImages(sess, resp.nextPageToken, token, user, env)
    output.push(...mediaItems)
  }
  return output
}

async function uploadImageToCF(
  mediaItem: PickedMediaItem,
  token: string,
  user: string,
  env: Env
) {

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
      'Authorization': `Bearer ${token}`,
    },
  }).catch( (err) => {
    console.log(`Unable to fetch baseurl: ${err}`)
    throw err
  });
  const bytes = await image.bytes();

  const uploadSessionStatus = {
    user: user,
    text: `Uploading image ${mediaItem.mediaFile.filename}`,
    finished: false,
    retry: false,
  }
  await updateSessionStatus(env, uploadSessionStatus)
  const fileName = `${mediaItem.createTime}-${mediaItem.mediaFile.filename}`
  env.PHOTO_BUCKET.put(fileName, bytes)
    .catch( (err) => {
      console.log(`Unable to upload to bucket: ${err}`)
      throw err
    })
  console.log("Uploaded image")
}

async function updateSessionStatus(
  env: Env, status: SessionStatus,
) {
  console.log(`Will set status: ${JSON.stringify(status)}`)
  await env.SESSION_KV.put(
    `${STATUS_PREFIX}/${status.user}`, JSON.stringify(status),
  ).catch((err) => {
    console.log(err)
    throw err
  })
}

async function checkStatusKey(user:string, env:Env): Promise<Response> {
  const status: SessionStatus | null = await env.SESSION_KV.get(`${SESSION_PREFIX}/${user}`, "json")
  if (!status) {
    return new Response(
      "No session exists for user", {
        status: 404,
      }
    )
  }

  if (status.finished) {
    await env.SESSION_KV.delete(`${STATUS_PREFIX}/${user}`)
  }

  return Response.json(status)
}

router.get('/check_status', async ({req, env, ctx}) => {
  console.log("Checking status")
  const payload = await checkJWTHeaders(env, req.headers)
  if (!payload.sub) {
    return new Response("JWT doesn't contain sub", { status: 403 })
  }
  const resp = checkStatusKey(payload.sub, env)

  const sessKV: KVSessionSet | null = await env.SESSION_KV.get(
    `${SESSION_PREFIX}/${payload.sub}`, "json",
  )
  if (!sessKV) {
    // session not set, we should return a 404 (from the status key not set)
    return await resp
  }
  ctx?.waitUntil(handleKVSessionSet(sessKV, env))

  return await resp
})

router.get('/', ({req, env}) => {
  // Login
  var baseURL = new URL(req.url)
  baseURL.pathname = REDIRECT_PATH
  var client = initOAuth2Client(env, baseURL.toString())

  console.log("Fetching index")
  return env.ASSETS.fetch('index.html')
})


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.handle(request, env, ctx)
  },
} satisfies ExportedHandler<Env>;
