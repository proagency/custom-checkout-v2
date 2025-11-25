(function () {
  // === GLOBAL CONFIG FROM <script> TAG ====================================
  const currentScript =
    document.currentScript ||
    (function () {
      const scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();

  const CONFIG = {
    baseEmv:
      currentScript && currentScript.dataset.amBaseEmv
        ? currentScript.dataset.amBaseEmv.trim()
        : null,
    webhookUrl:
      currentScript && currentScript.dataset.amWebhookUrl
        ? currentScript.dataset.amWebhookUrl.trim()
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

  function parseAmountFromDom(text) {
    if (!text) return null;
    const numeric = text.replace(/[^\d.]/g, "");
    if (!numeric) return null;
    const value = parseFloat(numeric);
    if (isNaN(value)) return null;
    return value; // 500.00 as number
  }

  // === CONTACT CACHE FOR 2-STEP FORMS ====================================
  let cachedFullName = null;
  let cachedEmail = null;
  let cachedPhone = null;

  function captureContactValues() {
    const nameInput = qs(SELECTORS.fullName);
    const emailInput = qs(SELECTORS.email);
    const phoneInput = qs(SELECTORS.phone);

    if (nameInput && !nameInput.dataset.amBound) {
      nameInput.dataset.amBound = "1";
      cachedFullName = nameInput.value.trim() || cachedFullName;
      nameInput.addEventListener("input", () => {
        cachedFullName = nameInput.value.trim();
      });
    }

    if (emailInput && !emailInput.dataset.amBound) {
      emailInput.dataset.amBound = "1";
      cachedEmail = emailInput.value.trim() || cachedEmail;
      emailInput.addEventListener("input", () => {
        cachedEmail = emailInput.value.trim();
      });
    }

    if (phoneInput && !phoneInput.dataset.amBound) {
      phoneInput.dataset.amBound = "1";
      cachedPhone = phoneInput.value.trim() || cachedPhone;
      phoneInput.addEventListener("input", () => {
        cachedPhone = phoneInput.value.trim();
      });
    }
  }

  // Local fallback orderId when no webhook
  function amGenerateLocalOrderId() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return "QR-" + ts + "-" + rand; // e.g. QR-MBKF3K-8F2A
  }

  // === EMV TLV PARSING & CRC =============================================

  function parseEmv(emv) {
    const fields = [];
    let i = 0;
    while (i + 4 <= emv.length) {
      const tag = emv.slice(i, i + 2);
      const lenStr = emv.slice(i + 2, i + 4);
      const len = parseInt(lenStr, 10);
      if (isNaN(len) || i + 4 + len > emv.length) {
        break;
      }
      const value = emv.slice(i + 4, i + 4 + len);
      fields.push({ tag, value });
      i += 4 + len;
    }
    return fields;
  }

  function buildEmvWithoutCRC(fields) {
    return fields
      .filter(f => f.tag !== "63")
      .map(
        f => f.tag + f.value.length.toString().padStart(2, "0") + f.value
      )
      .join("");
  }

  function crc16Ccitt(str) {
    let crc = 0xffff;
    for (let i = 0; i < str.length; i++) {
      let byte = str.charCodeAt(i);
      crc ^= byte << 8;
      for (let b = 0; b < 8; b++) {
        if (crc & 0x8000) {
          crc = ((crc << 1) ^ 0x1021) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }
    return crc & 0xffff;
  }

  function regenerateEmvWithAmount(baseEmv, amountNumber) {
    if (!baseEmv || typeof baseEmv !== "string") {
      throw new Error("Base EMV string is missing or invalid.");
    }

    const fields = parseEmv(baseEmv);
    if (!fields.length) {
      throw new Error("Could not parse EMV template.");
    }

    const formatted = amountNumber.toFixed(2); // e.g. 500.00

    let amountField = fields.find(f => f.tag === "54");
    if (amountField) {
      amountField.value = formatted;
    } else {
      const crcIndex = fields.findIndex(f => f.tag === "63");
      const newField = { tag: "54", value: formatted };
      if (crcIndex === -1) {
        fields.push(newField);
      } else {
        fields.splice(crcIndex, 0, newField);
      }
    }

    const baseWithoutCrc = buildEmvWithoutCRC(fields);
    const forCrc = baseWithoutCrc + "6304";
    const crc = crc16Ccitt(forCrc);
    const crcHex = crc.toString(16).toUpperCase().padStart(4, "0");

    const finalEmv = baseWithoutCrc + "63" + "04" + crcHex;
    return finalEmv;
  }

  function getMerchantFromBaseEmv() {
    if (!CONFIG.baseEmv) return null;
    try {
      const fields = parseEmv(CONFIG.baseEmv);
      const f = fields.find(x => x.tag === "59");
      return f ? f.value : null;
    } catch {
      return null;
    }
  }

  // === QR RENDERING WITH WHITE QUIET MARGIN ==============================
  function renderQrWithQuietZone(container, text) {
    if (typeof QRCode === "undefined") {
      console.error("[AM PAY] QRCode.js not loaded");
      return;
    }
    if (!container) return;

    container.innerHTML = "";
    const size = 220;

    const tempDiv = document.createElement("div");
    container.appendChild(tempDiv);

    new QRCode(tempDiv, {
      text: text,
      width: size,
      height: size,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });

    setTimeout(function () {
      let innerCanvas = tempDiv.querySelector("canvas");
      const innerImg = tempDiv.querySelector("img");

      if (!innerCanvas && innerImg) {
        const c = document.createElement("canvas");
        c.width = innerImg.naturalWidth || size;
        c.height = innerImg.naturalHeight || size;
        const cctx = c.getContext("2d");
        cctx.drawImage(innerImg, 0, 0);
        innerCanvas = c;
      }

      if (!innerCanvas) {
        container.innerHTML =
          '<span class="am-status am-status--error">Could not render QR</span>';
        return;
      }

      const quiet = 24;
      const finalCanvas = document.createElement("canvas");
      finalCanvas.width = innerCanvas.width + quiet * 2;
      finalCanvas.height = innerCanvas.height + quiet * 2;

      const ctx = finalCanvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
      ctx.drawImage(innerCanvas, quiet, quiet);

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
          <div id="am-qr-skeleton" class="am-qr-skeleton">
            <div class="am-skeleton-box"></div>
            <div class="am-skeleton-line"></div>
            <div class="am-skeleton-line am-skeleton-line--short"></div>
          </div>

          <div id="am-qr-content" class="am-qr-content am-hidden">
            <div id="am-qr-img"></div>

            <div class="am-order-row">
              <span class="am-meta-label">Merchant:</span>
              <span id="am-merchant-value" class="am-meta-value">—</span>
            </div>

            <div class="am-order-row">
              <span id="am-order-id-label">
                Order ID: <span id="am-order-id">—</span>
              </span>
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

    const merchantValueSpan = root.querySelector("#am-merchant-value");
    const orderIdSpan = root.querySelector("#am-order-id");
    const orderIdLabel = root.querySelector("#am-order-id-label");
    const copyOrderBtn = root.querySelector("#am-copy-order");
    const downloadQrBtn = root.querySelector("#am-download-qr");

    let selectedChannelType = "ewallet";
    let selectedChannel = null;
    let currentOrderId = null;
    let currentQrCode = null;

    const baseMerchantName = getMerchantFromBaseEmv();
    if (merchantValueSpan && baseMerchantName) {
      merchantValueSpan.textContent = baseMerchantName;
    }

    function getFullName() {
      if (fullNameInput && fullNameInput.value.trim()) {
        return fullNameInput.value.trim();
      }
      return cachedFullName || "";
    }

    function getEmail() {
      if (emailInput && emailInput.value.trim()) {
        return emailInput.value.trim();
      }
      return cachedEmail || "";
    }

    function getPhone() {
      if (phoneInput && phoneInput.value.trim()) {
        return phoneInput.value.trim();
      }
      return cachedPhone || "";
    }

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
      const nameOk = !!getFullName();
      const emailOk = !!getEmail();
      const phoneOk = !!getPhone();
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

        toggleBtns.forEach(b =>
          b.classList.toggle("am-toggle-btn--active", b === btn)
        );

        channelGroups.forEach(group => {
          const gType = group.getAttribute("data-channel-type");
          const isActive = gType === selectedChannelType;
          group.classList.toggle("am-hidden", !isActive);
          if (!isActive) {
            group
              .querySelectorAll('input[type="radio"]')
              .forEach(r => (r.checked = false));
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

    // Input listeners (only if visible on this step)
    [fullNameInput, emailInput, phoneInput].forEach(input => {
      if (!input) return;
      input.addEventListener("input", updatePayButtonState);
    });

    // Copy order ID
    copyOrderBtn.addEventListener("click", async () => {
      if (!currentOrderId) {
        setStatus("No Order ID to copy.", "error");
        return;
      }
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
        setStatus(
          "Unable to download QR. Please long-press / right-click to save.",
          "error"
        );
      }
    });

    // Pay via QR Now (hybrid: local EMV + optional webhook)
    payBtn.addEventListener("click", async () => {
      if (payBtn.disabled) return;

      setStatus("", null);

      if (!CONFIG.baseEmv) {
        setStatus(
          "No base EMV template configured. Please add data-am-base-emv on the script tag.",
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
      const amountNumber = parseAmountFromDom(rawAmount);

      if (amountNumber === null) {
        qrSection.classList.add("am-hidden");
        setStatus(
          "Could not read amount from checkout. Please check your setup.",
          "error"
        );
        return;
      }

      try {
        // 1️⃣ Always generate EMV & QR locally
        logDebug("Base EMV:", CONFIG.baseEmv);
        logDebug("Parsed amount from DOM:", amountNumber);

        const finalEmv = regenerateEmvWithAmount(CONFIG.baseEmv, amountNumber);
        currentQrCode = finalEmv;

        renderQrWithQuietZone(qrContainer, finalEmv);

        // Merchant: start with base merchant
        if (merchantValueSpan) {
          merchantValueSpan.textContent = baseMerchantName || "—";
        }

        // Local orderId if no webhook configured
        if (!CONFIG.webhookUrl) {
          currentOrderId = amGenerateLocalOrderId();
          orderIdSpan.textContent = currentOrderId;
          orderIdLabel.style.display = "";
        } else {
          currentOrderId = null;
          orderIdSpan.textContent = "—";
          orderIdLabel.style.display = "";
        }

        setTimeout(() => {
          qrSkeleton.classList.add("am-hidden");
          qrContent.classList.remove("am-hidden");
        }, 200);

        payBtn.classList.add("am-hidden");

        setStatus(
          "Scan the QR code with your payment app to complete the payment.",
          "success"
        );

        // 2️⃣ Optional webhook for logging/overrides
        if (CONFIG.webhookUrl) {
          const payload = {
            fullName: getFullName() || null,
            email: getEmail() || null,
            phone: getPhone() || null,
            amount: amountNumber,
            amountFormatted: amountNumber.toFixed(2),
            channelType: selectedChannelType,
            channel: selectedChannel,
            merchant: baseMerchantName || null,
            itemName: itemNameEl ? itemNameEl.textContent.trim() : null
          };

          logDebug("Sending webhook payload:", payload);
          setPayLoading(true);

          try {
            const res = await fetch(CONFIG.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });

            if (!res.ok) {
              throw new Error("Webhook request failed with " + res.status);
            }

            const data = await res.json();
            logDebug("Webhook response:", data);

            const returnedMerchant =
              data.merchant ||
              data.merchantName ||
              data.merchant_name ||
              null;

            const returnedOrderId =
              data.orderId || data.order_id || data.id || null;

            if (returnedMerchant && merchantValueSpan) {
              merchantValueSpan.textContent = returnedMerchant;
            }

            if (returnedOrderId) {
              currentOrderId = returnedOrderId;
              orderIdSpan.textContent = currentOrderId;
              orderIdLabel.style.display = "";
            }

            setStatus(
              "Scan the QR code with your payment app to complete the payment.",
              "success"
            );
          } catch (err) {
            console.error("[AM PAY] Webhook error:", err);
            setStatus(
              "Payment QR generated. We couldn't confirm order details, but you can still pay using the QR.",
              "error"
            );
          } finally {
            setPayLoading(false);
          }
        }
      } catch (err) {
        console.error("[AM PAY] Error generating EMV QR:", err);
        qrSection.classList.add("am-hidden");
        setStatus(
          "We couldn't generate the QR code. Please check the base EMV template.",
          "error"
        );
      }
    });

    updatePayButtonState();
  }

  // === ENSURE UI MOUNTED (INITIAL + MUTATIONS) ===========================
  function ensurePaymentUIMounted() {
    const host = qs(SELECTORS.host);
    if (!host) {
      logDebug("Host (.product-cost-total div .order-total) not found yet.");
      return;
    }

    const sibling = host.nextElementSibling;
    if (sibling && sibling.id === ROOT_ID) {
      return;
    }

    const existing = document.getElementById(ROOT_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    const root = document.createElement("div");
    root.id = ROOT_ID;
    host.insertAdjacentElement("afterend", root);
    buildUI(root);
    logDebug("Mounted #am-payment-root under host.");
  }

  // === MOUNTING: PAGE LOAD + DELAY + MUTATION OBSERVER ===================
  function mountAfterDelayOnce() {
    logDebug("Scheduling initial mount ~3s after page load…");
    setTimeout(function () {
      ensurePaymentUIMounted();
    }, 3000);
  }

  function setupMutationObserver() {
    try {
      const observer = new MutationObserver(function () {
        ensurePaymentUIMounted();
        captureContactValues();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      logDebug("MutationObserver attached for re-mounting + contact capture.");
    } catch (e) {
      console.error("[AM PAY] Failed to attach MutationObserver:", e);
    }
  }

  // === BOOTSTRAP =========================================================
  function loadQRCodeLibIfNeeded(cb) {
    if (typeof QRCode !== "undefined") {
      cb();
      return;
    }
    const s = document.createElement("script");
    s.src =
      "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = cb;
    s.onerror = function () {
      console.error("[AM PAY] Failed to load qrcode.js");
    };
    document.head.appendChild(s);
  }

  function start() {
    loadQRCodeLibIfNeeded(function () {
      captureContactValues();
      mountAfterDelayOnce();
      setupMutationObserver();
    });
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start);
  }
})();
