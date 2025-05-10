# Upload images to cloudflare R2 using the google photo picker API

I'm working on a photo sharing site, and wanted an easy way to import photos
into R2 from Google Photos.

> "Why go through this hassle instead of a just using an S3 uploader?"

Because I originally was going to upload these images to Cloudflare Images
(hence the name), but realized I didn't want to pay for storage 🙃. Once I got
that far I figured I'd just push this up. Who knows if I keep using it though 🤷


## How is this configured

* Worker deployed to cloudflare
* Created oauth app in google console, added app secrets
* OAuth app configured to
    * redirect to `<worker-domain>/oauth_callback`
    * photo picker API enabled for project
* Created zero trust org and access policy to only allow my gmail account
* Set worker behind access URL, added env vars for account tag and zero trust
  AUD
* Added new R2 bucket

## How does this work?

Static HTML page served at root path, with client-side javascript to update page
with current photo picker status. Backend worker that inits the oauth client,
and creates picker session for the end user. The worker then polls the picker
session until it's completed, before then fetching the selected images and
uploading them to R2 (while also updating the status for the user via cloudflare
KV).

## TODO

* [ ] Clean up error reporting
* [ ] Make status page responsive and sane looking
* [ ] Handle status and error setting for errs
