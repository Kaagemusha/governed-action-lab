// If the module never finishes booting, tell the visitor instead of hanging.
setTimeout(function () {
  if (document.documentElement.dataset.boot === "loading") {
    var s = document.getElementById("boot-status");
    if (s) s.textContent = "Still loading. Reload the page if nothing changes.";
  }
}, 6000);
