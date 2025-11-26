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

  // === DOM SELECTORS ======================================
  const ROOT_ID = "am-payment-root";

  const SELECTORS = {
    host: ".product-cost-total div .order-total", // inject UI after this
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
    return value;
  }

  // === BEST-EFFORT CONTACT HELPERS (FOR WEBHOOK ONLY) ====================
  function findFullName() {
    // 1-step
    const byInfo = document.querySelector(".info div input[type=text]");
    if (byInfo && byInfo.value.trim()) return byInfo.value.trim();

    // 2-step-ish: first text input in form-body
    const byFormBodyFirst = document.querySelector(
      ".form-body div input[type=text]:nth-child(1)"
    );
    if (byFormBodyFirst && byFormBodyFirst.value.trim())
      return byFormBodyFirst.value.trim();

    // fallback: any text input that doesn't look like email
    const candidates = Array.from(
      document.querySelectorAll(
        ".info input[type=text], .form-body input[type=text]"
      )
    );
    for (const c of candidates) {
      const val = (c.value || "").trim();
      if (!val) continue;
      if (val.includes("@")) continue; // probably email
      return val;
    }
    return null;
  }

  function findEmail() {
    const byType = document.querySelector(
      ".form-body input[type=email], .info input[type=email]"
    );
    if (byType && byType.value.trim()) return byType.value.trim();

    const byTextNth = document.querySelector(
      ".form-body div input[type=text]:nth-child(2)"
    );
    if (byTextNth && byTextNth.value.trim() && byTextNth.value.includes("@"))
      return byTextNth.value.trim();

    const textCandidates = Array.from(
      document.querySelectorAll(
        ".info input[type=text], .form-body input[type=text]"
      )
    );
    for (const c of textCandidates) {
      const val = (c.value || "").trim();
      if (val && val.includes("@")) return val;
      const ph = (c.placeholder || "").toLowerCase();
      if (ph.includes("email")) return val || null;
    }
    return null;
  }

  function findPhone() {
    const byTel = document.querySelector(
      ".form-body input[type=tel], .info input[type=tel]"
    );
    if (byTel && byTel.value.trim()) return byTel.value.trim();

    const candidates = Array.from(
      document.querySelectorAll(
        ".form-body input[type=text], .info input[type=text]"
      )
    );
    for (const c of candidates) {
      const ph = (c.placeholder || "").toLowerCase();
      if (
        ph.includes("phone") ||
        ph.includes("mobile") ||
        ph.includes("contact")
      ) {
        const val = (c.value || "").trim();
        if (val) return val;
      }
    }
    return null;
  }

  // === ORDER ID + EMV HELPERS ============================================
  function amGenerateLocalOrderId() {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return "QR-" + ts + "-" + rand;
  }

  function parseEmv(emv) {
    const fields = [];
    let i = 0;
    while (i + 4 <= emv.length) {
      const tag = emv.slice(i, i + 2);
      const lenStr = emv.slice(i + 2, i + 4);
      const len = parseInt(lenStr, 10);
      if (isNaN(len) || i + 4 + len > emv.length) break;
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

    const formatted = amountNumber.toFixed(2);

    let amountField = fields.find(f => f.tag === "54");
    if (amountField) {
      amountField.value = formatted;
    } else {
      const crcIndex = fields.findIndex(f => f.tag === "63");
      const newField = { tag: "54", value: formatted };
      if (crcIndex === -1) fields.push(newField);
      else fields.splice(crcIndex, 0, newField);
    }

    const baseWithoutCrc = buildEmvWithoutCRC(fields);
    const forCrc = baseWithoutCrc + "6304";
    const crc = crc16Ccitt(forCrc);
    const crcHex = crc.toString(16).toUpperCase().padStart(4, "0");

    return baseWithoutCrc + "63" + "04" + crcHex;
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
      text,
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
          Generate a QR code based on your order total and pay using your wallet or banking app.
        </p>

        <button type="button" id="am-pay-btn" class="am-primary-btn">
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

  // === UI LOGIC + VALIDATION ============================================
  function wireUpLogic(root) {
    const itemNameEl = qs(SELECTORS.itemName);
    const orderTotalEl = qs(SELECTORS.orderTotal);

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

    let currentOrderId = null;
    let currentQrCode = null;

    const baseMerchantName = getMerchantFromBaseEmv();
    if (merchantValueSpan && baseMerchantName) {
      merchantValueSpan.textContent = baseMerchantName;
    }

    // Contact elements for *validation* (not for webhook)
    const nameInputEl =
      document.querySelector(".info div input[type=text]") ||
      document.querySelector(".form-body div input[type=text]:nth-child(1)");

    const emailInputEl =
      document.querySelector(".form-body input[type=email]") ||
      document.querySelector(".form-body div input[type=text]:nth-child(2)");

    const phoneInputEl = document.querySelector(
      ".form-body input[type=tel], .info input[type=tel]"
    );

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

    // Validation logic:
    // - If we see any contact fields, require all visible ones to be non-empty.
    // - Always require amount to be parseable.
    // - If no contact fields are present (2-step payment-only view), don't block on them.
    function updatePayButtonState() {
      const nameVal = nameInputEl ? nameInputEl.value.trim() : "";
      const emailVal = emailInputEl ? emailInputEl.value.trim() : "";
      const phoneVal = phoneInputEl ? phoneInputEl.value.trim() : "";

      const hasAnyField = !!nameInputEl || !!emailInputEl || !!phoneInputEl;

      let contactOk;
      if (hasAnyField) {
        contactOk =
          (!nameInputEl || !!nameVal) &&
          (!emailInputEl || !!emailVal) &&
          (!phoneInputEl || !!phoneVal);
      } else {
        // Likely 2-step payment step only, GHL already enforced required fields
        contactOk = true;
      }

      const rawAmount = orderTotalEl ? orderTotalEl.textContent.trim() : null;
      const amountNumber = parseAmountFromDom(rawAmount);
      const amountOk = amountNumber !== null;

      payBtn.disabled = !(contactOk && amountOk);

      logDebug("updatePayButtonState", {
        hasAnyField,
        contactOk,
        amountOk,
        nameVal,
        emailVal,
        phoneVal,
        disabled: payBtn.disabled
      });
    }

    // Wire input listeners for live validation (1-step & some 2-step flows)
    [nameInputEl, emailInputEl, phoneInputEl].forEach(input => {
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

    // Pay via QR Now
    payBtn.addEventListener("click", async () => {
      if (payBtn.disabled) return;

      if (!CONFIG.baseEmv) {
        setStatus(
          "No base EMV template configured. Please add data-am-base-emv on the script tag.",
          "error"
        );
        return;
      }

      setStatus("", null);

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
        logDebug("Base EMV:", CONFIG.baseEmv);
        logDebug("Parsed amount from DOM:", amountNumber);

        const finalEmv = regenerateEmvWithAmount(CONFIG.baseEmv, amountNumber);
        currentQrCode = finalEmv;

        // Render QR
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

        setStatus(
          "Scan the QR code with your payment app to complete the payment.",
          "success"
        );

        // Optional webhook for logging / overrides
        if (CONFIG.webhookUrl) {
          setPayLoading(true);

          const payload = {
            fullName: findFullName(),
            email: findEmail(),
            phone: findPhone(),
            amount: amountNumber,
            amountFormatted: amountNumber.toFixed(2),
            channelType: null,
            channel: null,
            merchant: baseMerchantName || null,
            itemName: itemNameEl ? itemNameEl.textContent.trim() : null
          };

          logDebug("Sending webhook payload:", payload);

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

    // Initial validation state
    updatePayButtonState();
  }

  // === ENSURE UI MOUNTED ================================================
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

  // === MOUNTING: PAGE LOAD + MUTATION OBSERVER ===========================
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
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      logDebug("MutationObserver attached for re-mounting.");
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
