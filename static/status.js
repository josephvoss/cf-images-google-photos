function checkStatus() {
  fetch("/check_status").then( (resp) => {
    if (!resp.ok) {
      return
    } else {
      return resp.text()
    }
  }).then ((body) => {
    if (!body) {
      console.log("invalid body")
      return
    }
    document.getElementById("status_text").innerHTML = body;
  })
}

function clearSession() {
  fetch("/clear_session").then( (resp) => {
    if (!resp.ok) {
      return
    } else {
      return resp.text()
    }
  }).then ((body) => {
    if (!body) {
      console.log("invalid body")
      return
    }
    document.getElementById("status_text").innerHTML = body;
  })
}

// I don't understand promises
var sleep = duration => new Promise(resolve => setTimeout(resolve, duration))
var poll = (promiseFn, duration) => promiseFn().then(
  sleep(duration).then(() => poll(promiseFn, duration)))
checkStatus()
// Run checkStatus every 5 sec
poll( () => new Promise(
  () => {
    console.log(new Date().toISOString())
    checkStatus()
  }),
  5000)
