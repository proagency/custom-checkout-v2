(function () {
  // === CONFIG FROM <script> TAG ===========================================
  const currentScript = document.currentScript || (function () {
    const scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  })();

  const CONFIG = {
    webhookUrl: currentScript && currentScript.dataset.amWebhookUrl
      ? currentScript.dataset.amWebhookUrl.trim()
      : null,
    staticCode: currentScript && currentScript.dataset.amStaticCode
      ? currentScript.dataset.amStaticCode.trim()
      : null,
    debug: currentScript && currentScript.dataset.amDebug === "1"
  };

  function logDebug() {
    if (!CONFIG.debug) return;
    console.log.apply(console, ["[AM PAY]"].concat(Array.from(arguments)));
  }

  // === DOM SELECTORS (GHL checkout) ======================================
  const ROOT_ID = "am-payment-root";

  const SELECTORS = {
    host: ".product-cost-total div .order-total", // inject UI after this
    fullName: ".info div input[type=text]",
    email: ".form-body div input[type=text]:nth-child(2)",
    phone: ".form-body div input[type=tel]",
    itemName: ".product-cost-total .item span",
    orderTotal: ".order-total .item .item-price"
  };

  function qs(selector, ctx) {
    return (ctx || document).querySelector(selector);
  }

  function parseAmountToInt(text) {
    if (!text) return null;
    var numeric = text.replace(/[^\d.]/g, "");
    if (!numeric) return null;
    var value = parseFloat(numeric);
    if (isNaN(value)) return null;
    return Math.round(value);
  }

  // === QR RENDERING WITH WHITE QUIET MARGIN ==============================
  function renderQrWithQuietZone(container, text) {
    if (typeof QRCode === "undefined") {
      console.error("[AM PAY] QRCode.js not loaded");
      return;
    }
    if (!container) return;

    container.innerHTML = "";
    var size = 220;

    var tempDiv = document.createElement("div");
    container.appendChild(tempDiv);

    var qr = new QRCode(tempDiv, {
      text: text,
      width: size,
      height: size,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });

    setTimeout(function () {
      var innerCanvas = tempDiv.querySelector("canvas");
      var innerImg = tempDiv.querySelector("img");
      var srcCanvas = innerCanvas;

      if (!srcCanvas && innerImg) {
        var c = document.createElement("canvas");
        c.width = innerImg.naturalWidth || size;
        c.height = innerImg.naturalHeight || size;
        var cctx = c.getContext("2d");
        cctx.drawImage(innerImg, 0, 0);
        srcCanvas = c;
      }

      if (!srcCanvas) {
        container.innerHTML =
          '<span class="am-status am-status--error">Could not render QR</span>';
        return;
      }

      var quiet = 24;
      var finalCanvas = document.createElement("canvas");
      finalCanvas.width = srcCanvas.width + quiet * 2;
      finalCanvas.height = srcCanvas.height + quiet * 2;

      var ctx = finalCanvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
      ctx.drawImage(srcCanvas, quiet, quiet);

      container.innerHTML = "";
      container.appendChild(finalCanvas);
    }, 0);
  }

  // === UI BUILD ==========================================================
  function buildUI(root) {
    if (!root || root.dataset.amInitialized === "1") return;
    root.dataset.amInitialized = "1";

    logDebug("Building custom payment UI in", root);

    root.innerHTML = `
      <div class="am-card">
        <h3 class="am-title">
          <i class="fa-solid fa-qrcode"></i>
          Pay via QR
        </h3>
        <p class="am-subtitle">
          Choose your payment channel, then generate a QR code to complete your payment.
        </p>

        <div class="am-toggle-group">
          <button type="button" class="am-toggle-btn am-toggle-btn--active" data-channel-type="ewallet">
            <i class="fa-solid fa-wallet"></i>
            eWallet
          </button>
          <button type="button" class="am-toggle-btn" data-channel-type="bank">
            <i class="fa-solid fa-building-columns"></i>
            Bank Transfer
          </button>
        </div>

        <div class="am-channel-group" data-channel-type="ewallet">
          <label class="am-option">
            <input type="radio" name="am-channel" value="GCash" />
            <span>GCash</span>
          </label>
          <label class="am-option">
            <input type="radio" name="am-channel" value="Maya" />
            <span>Maya</span>
          </label>
        </div>

        <div class="am-channel-group am-hidden" data-channel-type="bank">
          <label class="am-option">
            <input type="radio" name="am-channel" value="BPI" />
            <span>BPI</span>
          </label>
          <label class="am-option">
            <input type="radio" name="am-channel" value="BDO" />
            <span>BDO</span>
          </label>
          <label class="am-option">
            <input type="radio" name="am-channel" value="RCBC" />
            <span>RCBC</span>
          </label>
          <label class="am-option">
            <input type="radio" name="am-channel" value="UNIONBANK" />
            <span>UNIONBANK</span>
          </label>
        </div>

        <button type="button" id="am-pay-btn" class="am-primary-btn" disabled>
          <span class="am-btn-label">Pay via QR Now</span>
          <span class="am-btn-spinner am-hidden">
            <i class="fa-solid fa-spinner fa-spin"></i>
          </span>
        </button>

        <div id="am-status" class="am-status"></div>

        <div id="am-qr-section" class="am-qr-section am-hidden">
  <!-- Skeleton for QR -->
  <div id="am-qr-skeleton" class="am-qr-skeleton">
    <div class="am-skeleton-box"></div>
    <div class="am-skeleton-line"></div>
    <div class="am-skeleton-line am-skeleton-line--short"></div>
  </div>

  <!-- Actual QR content -->
  <div id="am-qr-content" class="am-qr-content am-hidden">
    <div id="am-qr-img"></div>
    <div class="am-order-row">
      <span id="am-order-id-label">Order ID: <span id="am-order-id"></span></span>
      <button type="button" id="am-copy-order" class="am-icon-btn" title="Copy Order ID">
        <i class="fa-solid fa-copy"></i>
      </button>
    </div>

    <div class="am-qr-actions">
      <button type="button" id="am-download-qr" class="am-secondary-btn">
        <i class="fa-solid fa-download"></i> Download QR
      </button>
    </div>
  </div>
</div>

      </div>
    `;

    wireUpLogic(root);
  }

  // === UI LOGIC ==========================================================
  function wireUpLogic(root) {
    const fullNameInput = qs(SELECTORS.fullName);
    const emailInput = qs(SELECTORS.email);
    const phoneInput = qs(SELECTORS.phone);
    const itemNameEl = qs(SELECTORS.itemName);
    const orderTotalEl = qs(SELECTORS.orderTotal);

    const toggleGroup = root.querySelector(".am-toggle-group");
    const toggleBtns = root.querySelectorAll(".am-toggle-btn");
    const channelGroups = root.querySelectorAll(".am-channel-group");
    const payBtn = root.querySelector("#am-pay-btn");
    const payLabel = root.querySelector(".am-btn-label");
    const paySpinner = root.querySelector(".am-btn-spinner");
    const statusEl = root.querySelector("#am-status");

    const qrSection = root.querySelector("#am-qr-section");
    const qrSkeleton = root.querySelector("#am-qr-skeleton");
    const qrContent = root.querySelector("#am-qr-content");
    const qrContainer = root.querySelector("#am-qr-img");
    const orderIdSpan = root.querySelector("#am-order-id");
    const orderIdLabel = root.querySelector("#am-order-id-label");
    const copyOrderBtn = root.querySelector("#am-copy-order");
    const downloadQrBtn = root.querySelector("#am-download-qr"); 

    let selectedChannelType = "ewallet";
    let selectedChannel = null;
    let currentOrderId = null;
    let currentQrCode = null;

    function setStatus(message, type) {
      statusEl.textContent = message || "";
      statusEl.classList.remove("am-status--error", "am-status--success");
      if (type === "error") statusEl.classList.add("am-status--error");
      if (type === "success") statusEl.classList.add("am-status--success");
    }

    function setPayLoading(isLoading) {
      if (isLoading) {
        payBtn.disabled = true;
        payLabel.classList.add("am-hidden");
        paySpinner.classList.remove("am-hidden");
      } else {
        payLabel.classList.remove("am-hidden");
        paySpinner.classList.add("am-hidden");
        updatePayButtonState();
      }
    }

    function updatePayButtonState() {
      const nameOk = !!(fullNameInput && fullNameInput.value.trim());
      const emailOk = !!(emailInput && emailInput.value.trim());
      const phoneOk = !!(phoneInput && phoneInput.value.trim());
      const channelOk = !!selectedChannelType && !!selectedChannel;
      payBtn.disabled = !(nameOk && emailOk && phoneOk && channelOk);
    }

    // Toggle eWallet / Bank
    toggleBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const type = btn.getAttribute("data-channel-type");
        if (!type || type === selectedChannelType) return;

        selectedChannelType = type;
        selectedChannel = null;
        setStatus("", null);

        toggleBtns.forEach(b => b.classList.toggle("am-toggle-btn--active", b === btn));

        channelGroups.forEach(group => {
          const gType = group.getAttribute("data-channel-type");
          const isActive = gType === selectedChannelType;
          group.classList.toggle("am-hidden", !isActive);
          if (!isActive) {
            group.querySelectorAll('input[type="radio"]').forEach(r => (r.checked = false));
          }
        });

        updatePayButtonState();
      });
    });

    // Channel selection
    channelGroups.forEach(group => {
      group.querySelectorAll('input[type="radio"]').forEach(radio => {
        radio.addEventListener("change", () => {
          if (radio.checked) {
            selectedChannel = radio.value;
            setStatus("", null);
            updatePayButtonState();
          }
        });
      });
    });

    // Validate inputs
    [fullNameInput, emailInput, phoneInput].forEach(input => {
      if (!input) return;
      input.addEventListener("input", updatePayButtonState);
    });

    // Copy order ID
    copyOrderBtn.addEventListener("click", async () => {
      if (!currentOrderId) return;
      try {
        await navigator.clipboard.writeText(currentOrderId);
        setStatus("Order ID copied to clipboard.", "success");
      } catch {
        setStatus("Unable to copy Order ID. Please copy manually.", "error");
      }
    });

    // Download QR
downloadQrBtn.addEventListener("click", () => {
  if (!qrContainer) return;
  const canvas = qrContainer.querySelector("canvas");
  if (!canvas) {
    setStatus("QR is not ready to download yet.", "error");
    return;
  }

  try {
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `qr-${currentOrderId || "payment"}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setStatus("QR downloaded as image.", "success");
  } catch (e) {
    console.error(e);
    setStatus("Unable to download QR. Please long-press / right-click to save.", "error");
  }
});


    // Pay via QR Now click
    payBtn.addEventListener("click", async () => {
      if (payBtn.disabled) return;

      setStatus("", null);

      if (!CONFIG.webhookUrl && !CONFIG.staticCode) {
        setStatus(
          "No webhook or static QR code defined. Please contact support.",
          "error"
        );
        return;
      }

      if (toggleGroup) toggleGroup.classList.add("am-hidden");
      channelGroups.forEach(group => group.classList.add("am-hidden"));

      qrSection.classList.remove("am-hidden");
      qrSkeleton.classList.remove("am-hidden");
      qrContent.classList.add("am-hidden");

      const rawAmount = orderTotalEl ? orderTotalEl.textContent.trim() : null;
      const amountInt = parseAmountToInt(rawAmount);

      const payload = {
        fullName: fullNameInput ? fullNameInput.value.trim() : null,
        email: emailInput ? emailInput.value.trim() : null,
        phone: phoneInput ? phoneInput.value.trim() : null,
        channelType: selectedChannelType,
        channel: selectedChannel,
        itemName: itemNameEl ? itemNameEl.textContent.trim() : null,
        orderTotal: amountInt,
        orderTotalRaw: rawAmount
      };

      function finalizeQR(codeString, orderId) {
        currentQrCode = codeString;
        currentOrderId = orderId || null;

        renderQrWithQuietZone(qrContainer, codeString);

        if (currentOrderId) {
          orderIdSpan.textContent = currentOrderId;
          orderIdLabel.style.display = "";
        } else {
          orderIdLabel.style.display = "none";
        }

        qrSkeleton.classList.add("am-hidden");
        qrContent.classList.remove("am-hidden");

        payBtn.classList.add("am-hidden");

        setStatus(
          "Scan the QR code with your payment app to complete the payment.",
          "success"
        );
      }

      try {
        setPayLoading(true);

        if (CONFIG.webhookUrl) {
          logDebug("Sending POST to webhook:", CONFIG.webhookUrl, payload);

          const res = await fetch(CONFIG.webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (!res.ok) throw new Error("Webhook request failed with " + res.status);

          const data = await res.json();
          logDebug("Webhook response:", data);

          const code =
            data.code || data.qr || data.qr_code || data.payload || null;
          const orderId =
            data.orderId || data.order_id || data.id || null;

          if (!code) {
            throw new Error("Missing QR code string in webhook response.");
          }

          finalizeQR(code, orderId);

        } else if (CONFIG.staticCode) {
          logDebug("Using static QR payload from data-am-static-code");
          setTimeout(function () {
            finalizeQR(CONFIG.staticCode, null);
          }, 400);
        }
      } catch (err) {
        console.error("[AM PAY] Error generating QR:", err);
        qrSection.classList.add("am-hidden");
        setStatus(
          "We couldn't generate the QR code. Please try again or contact support.",
          "error"
        );
      } finally {
        setPayLoading(false);
      }
    });

    updatePayButtonState();
  }

  // === MOUNTING: PAGE LOAD + 3s DELAY ====================================

  let uiMounted = false;

  function mountAfterDelay() {
    if (uiMounted) return;

    logDebug("Scheduling mount 3s after page load…");

    setTimeout(function () {
      const maxMs = 7000;
      const intervalMs = 250;
      const start = Date.now();

      const poll = setInterval(function () {
        if (uiMounted) {
          clearInterval(poll);
          return;
        }

        const elapsed = Date.now() - start;
        const host = qs(SELECTORS.host);

        if (host) {
          clearInterval(poll);
          uiMounted = true;

          logDebug("Found host element, injecting #am-payment-root under it.");

          let root = document.getElementById(ROOT_ID);
          if (!root) {
            root = document.createElement("div");
            root.id = ROOT_ID;
            host.insertAdjacentElement("afterend", root);
          }

          buildUI(root);
        } else if (elapsed >= maxMs) {
          clearInterval(poll);
          logDebug("Timed out waiting for .product-cost-total div .order-total");
        }
      }, intervalMs);
    }, 3000);
  }

  // === BOOTSTRAP =========================================================

  function loadQRCodeLibIfNeeded(cb) {
    if (typeof QRCode !== "undefined") {
      cb();
      return;
    }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = cb;
    s.onerror = function () {
      console.error("[AM PAY] Failed to load qrcode.js");
    };
    document.head.appendChild(s);
  }

  function start() {
    // Assumption: one-step order, in-page (not in modal)
    loadQRCodeLibIfNeeded(mountAfterDelay);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start);
  }
})();

