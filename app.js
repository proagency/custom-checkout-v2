(function () {
  // 🔧 Set your webhook URL here
  const WEBHOOK_URL = "https://hook.us2.make.com/qm9b5x9qfor912v3a2a4k4bxtwwbquak";
  const ROOT_ID = "am-payment-root";

  const SELECTORS = {
    formId: "one-step-order-GNis8WfZ4k",
    hostInsideForm: ".product-cost-total div .order-total", // inject UI under this
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
    return Math.round(value); // P399.00 -> 399
  }

  function buildUI(root) {
    if (!root || root.dataset.amInitialized === "1") return;
    root.dataset.amInitialized = "1";

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
      <div id="am-qr-skeleton" class="am-qr-skeleton">
        <div class="am-skeleton-box"></div>
        <div class="am-skeleton-line"></div>
        <div class="am-skeleton-line am-skeleton-line--short"></div>
      </div>

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
          <button type="button" id="am-track-order" class="am-secondary-btn">
            <span class="am-track-label">
              <i class="fa-solid fa-magnifying-glass"></i> Track Order
            </span>
            <span class="am-track-spinner am-hidden">
              <i class="fa-solid fa-spinner fa-spin"></i>
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- 🔻 New banner just under the payments UI -->
    <div class="am-banner">
      <img
        src="https://storage.googleapis.com/msgsndr/6GpRgb6mNVCOYypKIoFG/media/691f964e51f40006324ada21.png"
        alt="Secure payment powered by AutomationMasters"
        loading="lazy"
      />
    </div>
  </div>
`;


    wireUpLogic(root);
  }

  function wireUpLogic(root) {
    const form = document.getElementById(SELECTORS.formId) || document;
    const fullNameInput = qs(SELECTORS.fullName, form);
    const emailInput = qs(SELECTORS.email, form);
    const phoneInput = qs(SELECTORS.phone, form);
    const itemNameEl = qs(SELECTORS.itemName, form);
    const orderTotalEl = qs(SELECTORS.orderTotal, form);

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
    const trackOrderBtn = root.querySelector("#am-track-order");
    const trackLabel = root.querySelector(".am-track-label");
    const trackSpinner = root.querySelector(".am-track-spinner");

    let selectedChannelType = "ewallet";
    let selectedChannel = null;
    let currentOrderId = null;
    let currentQrData = null;

    function setStatus(message, isError) {
      statusEl.textContent = message || "";
      statusEl.classList.toggle("am-status--error", !!isError);
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

    function setTrackLoading(isLoading) {
      if (isLoading) {
        trackOrderBtn.disabled = true;
        trackLabel.classList.add("am-hidden");
        trackSpinner.classList.remove("am-hidden");
      } else {
        trackOrderBtn.disabled = false;
        trackLabel.classList.remove("am-hidden");
        trackSpinner.classList.add("am-hidden");
      }
    }

    function updatePayButtonState() {
      const nameOk = !!(fullNameInput && fullNameInput.value.trim());
      const emailOk = !!(emailInput && emailInput.value.trim());
      const phoneOk = !!(phoneInput && phoneInput.value.trim());
      const channelOk = !!selectedChannelType && !!selectedChannel;
      payBtn.disabled = !(nameOk && emailOk && phoneOk && channelOk);
    }

    function renderQr(code) {
  if (typeof QRCode === "undefined") {
    console.error("[AM QR] QRCode.js not loaded");
    setStatus("QR library not available. Please refresh the page.", true);
    return;
  }
  if (!qrContainer) return;

  // Clear previous QR
  qrContainer.innerHTML = "";

  // Base QR size (the inner code, before adding quiet margin)
  var baseSize = 220;

  // Let QRCode.js render into the container first
  var qr = new QRCode(qrContainer, {
    text: code,
    width: baseSize,
    height: baseSize,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  // After it renders, wrap it with an extra white quiet margin
  // Some versions render <canvas>, some <img>, so we handle both.
  setTimeout(function () {
    var innerCanvas = qrContainer.querySelector("canvas");
    var innerImg = qrContainer.querySelector("img");

    // If it rendered as <img>, draw it to a temp canvas first
    if (!innerCanvas && innerImg) {
      var tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = innerImg.naturalWidth || baseSize;
      tmpCanvas.height = innerImg.naturalHeight || baseSize;
      var tctx = tmpCanvas.getContext("2d");
      tctx.drawImage(innerImg, 0, 0);
      innerCanvas = tmpCanvas;
    }

    if (!innerCanvas) {
      console.warn("[AM QR] No inner canvas or image found after QR render.");
      return;
    }

    // Quiet margin (in pixels) around the QR
    var quiet = 24; // tweak if you want more/less border

    var finalCanvas = document.createElement("canvas");
    finalCanvas.width = innerCanvas.width + quiet * 2;
    finalCanvas.height = innerCanvas.height + quiet * 2;

    var ctx = finalCanvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // white quiet zone
    ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
    ctx.drawImage(innerCanvas, quiet, quiet);

    // Replace whatever QRCode.js put in the container with our padded canvas
    qrContainer.innerHTML = "";
    qrContainer.appendChild(finalCanvas);
  }, 0);
}


    // Toggle eWallet / Bank
    toggleBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const type = btn.getAttribute("data-channel-type");
        if (!type || type === selectedChannelType) return;

        selectedChannelType = type;
        selectedChannel = null;
        setStatus("", false);

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
            setStatus("", false);
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

    // Pay via QR Now click
    payBtn.addEventListener("click", async () => {
      if (payBtn.disabled) return;

      setStatus("", false);

      // Hide channel type + selectors after clicking
      if (toggleGroup) toggleGroup.classList.add("am-hidden");
      channelGroups.forEach(group => group.classList.add("am-hidden"));

      qrSection.classList.remove("am-hidden");
      qrSkeleton.classList.remove("am-hidden");
      qrContent.classList.add("am-hidden");

      const rawAmount = orderTotalEl ? orderTotalEl.textContent.trim() : null;
      const amountInt = parseAmountToInt(rawAmount);

      const payload = {
        action: "create",
        fullName: fullNameInput ? fullNameInput.value.trim() : null,
        email: emailInput ? emailInput.value.trim() : null,
        phone: phoneInput ? phoneInput.value.trim() : null,
        channelType: selectedChannelType,
        channel: selectedChannel,
        itemName: itemNameEl ? itemNameEl.textContent.trim() : null,
        orderTotal: amountInt,
        orderTotalRaw: rawAmount
      };

      try {
        setPayLoading(true);

        const res = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("Webhook request failed");

        const data = await res.json();
        console.log("Webhook response:", data);

        // Expecting: { orderId, code }
        currentOrderId = data.orderId || data.order_id || data.id || null;
        currentQrData = data.code || data.qr || data.qr_code || null;

        if (!currentQrData) {
          throw new Error("Missing QR code string in webhook response (expected 'code').");
        }

        renderQr(currentQrData);

        if (currentOrderId) {
          orderIdSpan.textContent = currentOrderId;
          orderIdLabel.style.display = "";
        } else {
          orderIdLabel.style.display = "none";
        }

        qrSkeleton.classList.add("am-hidden");
        qrContent.classList.remove("am-hidden");

        // hide Pay button after a successful submit
        payBtn.classList.add("am-hidden");

        setStatus("Scan the QR code with your payment app to complete the payment.", false);
      } catch (err) {
        console.error(err);
        qrSection.classList.add("am-hidden");
        setStatus("We couldn't generate the QR code. Please try again in a moment.", true);
      } finally {
        setPayLoading(false);
      }
    });

    // Copy order ID
    copyOrderBtn.addEventListener("click", async () => {
      if (!currentOrderId) return;
      try {
        await navigator.clipboard.writeText(currentOrderId);
        setStatus("Order ID copied to clipboard.", false);
      } catch {
        setStatus("Unable to copy Order ID. Please copy manually.", true);
      }
    });

    // Download QR
    downloadQrBtn.addEventListener("click", () => {
      if (!qrContainer) return;
      const canvas = qrContainer.querySelector("canvas");
      if (!canvas) return;

      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = `qr-${currentOrderId || "payment"}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });

    // Track order
    trackOrderBtn.addEventListener("click", async () => {
      if (!currentOrderId) {
        setStatus("Generate a QR code first before tracking the order.", true);
        return;
      }

      const payload = {
        action: "track",
        orderId: currentOrderId
      };

      try {
        setTrackLoading(true);
        setStatus("", false);

        const res = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("Track request failed");

        const data = await res.json();
        const status = (data.status || "").toLowerCase();

        if (status === "pending") {
          setStatus(
            "We are still verifying your payment. This can take up to 15 minutes. If you don't receive access within an hour, email us at support@automationmasters.net.",
            false
          );
        } else if (status === "paid" || status === "success") {
          setStatus(
            data.message || "Payment verified. You should receive access shortly. Check your email.",
            false
          );
        } else {
          setStatus(
            data.message ||
              "We couldn't verify the payment yet. Please try again later or contact support.",
            true
          );
        }
      } catch (err) {
        console.error(err);
        setStatus("We couldn't check the status right now. Please try again shortly.", true);
      } finally {
        setTrackLoading(false);
      }
    });

    updatePayButtonState();
  }

  // --- Button-click → 3s delay → inject inside the form under .product-cost-total div .order-total ---

  let uiMounted = false;

  function mountAfterDelay() {
    if (uiMounted) return;

    setTimeout(function () {
      if (uiMounted) return;

      const form = document.getElementById(SELECTORS.formId);
      if (!form) {
        console.warn("[AM QR] Form #one-step-order-GNis8WfZ4k not found after 3s.");
        return;
      }

      const host = form.querySelector(SELECTORS.hostInsideForm);
      if (!host) {
        console.warn("[AM QR] .product-cost-total div .order-total not found inside form after 3s.");
        return;
      }

      let root = document.getElementById(ROOT_ID);
      if (!root) {
        root = document.createElement("div");
        root.id = ROOT_ID;
        host.insertAdjacentElement("afterend", root); // inject *under* order total
      }

      uiMounted = true;
      buildUI(root);
    }, 3000);
  }

  function startMounting() {
    const triggerSelectors = ["#button-I03geDGYX-", "#button-b8nnnCyH_x"];

    triggerSelectors.forEach(sel => {
      const btn = qs(sel);
      if (btn) {
        btn.addEventListener("click", mountAfterDelay);
      }
    });

    // Edge case: modal already open & form already rendered on refresh
    const form = document.getElementById(SELECTORS.formId);
    if (form && form.querySelector(SELECTORS.hostInsideForm)) {
      mountAfterDelay();
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    startMounting();
  } else {
    document.addEventListener("DOMContentLoaded", startMounting);
  }
})();
