import { Router } from '@tsndr/cloudflare-worker-router'
import { google, Auth } from 'googleapis'
import * as jose from 'jose'

import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent
} from 'cloudflare:workers'

const GOOGLE_PHOTOPICKER_URL = "https://photospicker.googleapis.com"
const REDIRECT_PATH = '/oauth_callback'
const CF_JWT_HEADER = 'cf-access-jwt-assertion'

interface Env {
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
  UPLOAD_WORKFLOW: Workflow;
  CHILD_WORKFLOW: Workflow;
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
  description: string,
}

enum MediaType {
  TYPE_UNSPECIFIED,
  PHOTO,
  VIDEO,
}

// Custom workflow types
// Workflow related types
interface WorkflowParams {
  sessionId: string
  pollDuration: number
  token: string
}

// router init and types
// Request Extension
export type ExtReq = {
    userId?: number
    url?: string
}
// Context Extension
//export type ExtCtx = {}
//const router = new Router<Env, ExtCtx, ExtReq>()
const router = new Router<Env, ExtReq>()

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
router.use( async ({ env, req }) => {
  return await checkJWTHeaders(env, req.headers)
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

async function getPickerSession(
  sessId: string, token: string,
): Promise<PickerSessionResp> {
  return await fetch(
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
): Promise<PickedMediaItem[]> {
  const output = new Array<PickedMediaItem>
  const url = new URL(`${GOOGLE_PHOTOPICKER_URL}/v1/mediaItems`)
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
    const mediaItems = await fetchImages(sess, resp.nextPageToken, token)
    output.push(...mediaItems)
  }
  return output
}

async function uploadImageToCF(
  mediaItem: PickedMediaItem,
  token: string,
  env: Env
) {

  const {width, height} = mediaItem.mediaFile.mediaFileMetadata
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

  const fileName = `${mediaItem.createTime}-${mediaItem.mediaFile.filename}`
  const putOpts: R2PutOptions = {
    customMetadata: {
      mimeType: mediaItem.mediaFile.mimeType,
      createTime: mediaItem.createTime,
      description: mediaItem.mediaFile.description,
    }
  }
  await env.PHOTO_BUCKET.put(fileName, bytes, putOpts)
    .catch( (err) => {
      console.log(`Unable to upload to bucket: ${err}`)
      throw err
    })
  console.log(`Uploaded image ${fileName}`)
}

// Format google's picker api poll duration to something workflow can use
function pollIntervalToWorkflowDuration(input: string): number {
  // Input format is fractional seconds suffixed w/ `s`
  // Output is either milliseconds or human readable (not fractional) `1 second`
  return Number(input.slice(0, -1)) * 1000
}

router.get('/login', ({env, req}) => {
  const baseURL = new URL(req.url)
  baseURL.pathname = REDIRECT_PATH
  const client = initOAuth2Client(env, baseURL.toString())
  // Redirect to google oauth login
  return Response.redirect(getOAuthClientUrl(client))
})

router.get(REDIRECT_PATH, async ({env, req}) => {
  // Get tokens
  const url = new URL(req.url)
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

  // Start upload workflow, save id under payload.sub
  const workflow = await env.UPLOAD_WORKFLOW.create({
    params: {
      sessionId: response.id,
      pollDuration: pollIntervalToWorkflowDuration(
        response.pollingConfig.pollInterval,
      ),
      token: tokens.access_token,
    }
  })
  await env.SESSION_KV.put(payload.sub, workflow.id)

  // Return picker URI redirect
  // why? I guess this is to google so it doesn't matter
  return Response.redirect(response.pickerUri)

})

router.get('/check_status', async ({req, env}) => {
  console.log("Checking status")
  const payload = await checkJWTHeaders(env, req.headers)
  if (!payload.sub) {
    return new Response("JWT doesn't contain sub", { status: 403 })
  }

  const workflowID = await env.SESSION_KV.get(payload.sub)
  if (!workflowID) {
    return new Response(
      "No workflow exists for user", {
        status: 404,
      }
    )
  }

  const workflow = await env.UPLOAD_WORKFLOW.get(workflowID)
  if (!workflow) {
    // session not set, we should return a 404 (from the status key not set)
    return new Response(
      "No workflow exists for user", {
        status: 404,
      }
    )
  }

  const status = await workflow.status()
  let output = ""
  switch (status.status) {
    case "running":
      output = `Upload is ${status.status}`
      break
    case "complete":
      output = `Upload is ${status.status}`
      break
    default:
      output = JSON.stringify(status)
  }
  return new Response(output)
})

router.get('/clear_session', async ({req, env}) => {
  const payload = await checkJWTHeaders(env, req.headers)
  if (!payload.sub) {
    return new Response("JWT doesn't contain sub", { status: 403 })
  }

  const workflowID = await env.SESSION_KV.get(payload.sub)
  if (!workflowID) {
    return new Response(
      "No workflow exists for user", {
        status: 404,
      }
    )
  }
  const workflow = await env.UPLOAD_WORKFLOW.get(workflowID)
  if (!workflow) {
    return new Response(
      "No workflow exists for user", {
        status: 404,
      }
    )
  }
  // Check if it's still running
  const status = await workflow.status()
  if (status.status == "running") {
    await workflow.terminate()
  }
  await env.SESSION_KV.delete(payload.sub)
  return new Response(`Cleared session for ${payload.email}`)
})

router.get('/', ({env}) => {
  console.log("Fetching index")
  return env.ASSETS.fetch('index.html')
})

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return router.handle(request, env, ctx)
  },
} satisfies ExportedHandler<Env>;

/*
 * User clicks login, redirected to google oauth
 * if successful, returns to callback
 * callback sets session in KV, starts workflow
 * Workflow
 *  polls session kv
 *  when done, uploads photos
 */
// TODO save IDs to kv
export class PhotoUpload extends WorkflowEntrypoint<Env, WorkflowParams> {
	override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		const { sessionId, pollDuration, token } = event.payload;

    // Don't return until picker session complete
		const rPickSess: PickerSessionResp = await step.do(
      'Poll picker session',
      {
        retries: {
          limit: Infinity,
          delay: pollDuration,
          backoff: "constant",
        },
        // set? default to 24hr
        timeout: "10 minutes",
      }, async () => {

      const pickerSess = await getPickerSession(
        sessionId, token,
      )
      if (!pickerSess.mediaItemsSet) {
        console.log(`Waiting in poller: ${new Date().toISOString()}`)
        // error and rely on retry
        throw new Error("Waiting for picker session")
      }
      // Session complete, return
      return pickerSess
    })

    const mediaItems: PickedMediaItem[] = await step.do(
      "Fetch media from gphotos",
      async () => { return await fetchImages(rPickSess, null, token) }
    )

    // Upload images to R2
    const childWorkflows = await step.do(
      `Spawning workflows for upload`, async () => {
      const childWorkflows = []
      const chunkSize = 45;
      for (let i = 0; i < mediaItems.length; i += chunkSize) {
          const chunk = mediaItems.slice(i, i + chunkSize);
          const childWorkflow = await this.env.CHILD_WORKFLOW.create({params:{token: token, mediaItems: chunk}})
          childWorkflows.push(childWorkflow.id)
      }
      return childWorkflows
    })

    await step.do(`Wait for uploads to finish`, {
        retries: {
          limit: 3,
          delay: "5 seconds",
          backoff: "constant",
        },
        timeout: "5 minutes",
      }, async () => {
        for (const child of childWorkflows) {
          const workflow = await this.env.CHILD_WORKFLOW.get(child)
          if (!workflow) {
            console.log("workflow not started")
          }
          let cStatus = await workflow.status()
          while (cStatus.status != "complete") {
            await new Promise(resolve => { setTimeout(resolve, 2000) })
            cStatus = await workflow.status()
          }
        }
      }
    )

    return "Upload complete"
	}
}

interface ChildWorkflowParams {
  token: string
  mediaItems: PickedMediaItem[]
}

export class PhotoUploadChild extends WorkflowEntrypoint<Env, ChildWorkflowParams> {
	override async run(event: WorkflowEvent<ChildWorkflowParams>, step: WorkflowStep) {

		const { mediaItems, token } = event.payload;

    for (const media of mediaItems) {
      await step.do(`Adding new images to R2`, async () => {
          await uploadImageToCF(media, token, this.env)
      })
    }

    return 
	}
}
