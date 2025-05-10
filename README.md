# Config

* Worker deployed to URL
* Secrets for oauth stuff
* Oauth client configured in gconsole
* photo picker API enabled for project in gconsole
* Worker set behind access URL, AUD for zero trust org set in config
* bucket configured

## TODO

* image viewer
    * https://www.lightgalleryjs.com/#lg=nature&slide=0
    * https://photoswipe.com/
    * https://fancyapps.com/fancybox/
* How to serve? Static html from page yeah, but then something needs to fetch
  the images from the bucket
    * new worker
* How to integrate with cloudflare images?
[ ] Clean up error reporting
[ ] Make status page responsive and sane looking
[ ] Handle status and error setting for errs
