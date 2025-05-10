function checkStatus() {
  fetch("/check_status").then( (resp) => {
    if (!resp.ok) {
      // login visible
      // status_text hidden
      // TODO we should return err. How to handle first thing?
      // Assumed only err would be 404, should check status code
      return
    } else {
      console.log("returning json")
      return resp.json()
    }
  }).then ((body) => {
    if (!body) {
      console.log("invalid body")
      return
    }
    if (body.text) {
      // update text
      console.log("status text set")
      document.getElementById("status_text").innerHTML = body.text;
    }
    if (body.retry) {
      // set login and status visible
      console.log("retry set")
      document.getElementById("login_link").style.display = 'block';
      document.getElementById("status_text").style.display = 'block';
    }
    if (body.finished) {
      // goodbye
      document.getElementById("login_link").style.display = 'hidden';
      document.getElementById("status_text").style.display = 'block';
      document.getElementById("status_text").innerHTML = 'Complete. Goodbye';
    }
  })
}

// I don't understand promises
var sleep = duration => new Promise(resolve => setTimeout(resolve, duration))
var poll = (promiseFn, duration) => promiseFn().then(
  sleep(duration).then(() => poll(promiseFn, duration)))
// Run checkStatus every 5 sec
poll( () => new Promise(
  () => {
    console.log(new Date().toISOString())
    checkStatus()
  }),
  5000)
