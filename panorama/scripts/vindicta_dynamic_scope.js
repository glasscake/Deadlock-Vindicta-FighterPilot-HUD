(function () {
  "use strict";

  var ENABLE_SOUNDS = true;

  var ACTIVE_INTERVAL = 0.016;
  var IDLE_INTERVAL = 0.15;
  var DEBUG_LOG_INTERVAL = 1.0;
  var FLIGHT_COMPLETE_EPSILON = 0.001;
  var VINDICTA_HERO_NAME = "hornet";
  var DEBUG = true;

  var SCOPE_END_GRACE_MS = 50;
  var LOCK_ARM_DELAY_MS = 150;
  var FIRE_ENTER_PROGRESS = 0.95;
  var FIRE_EXIT_PROGRESS = 0.90;
  var FLIGHT_SEARCH_INTERVAL_MS = 250;
  var FLIGHT_STALE_MS = 400;
  var OWNER_TIMEOUT_MS = 500;
  var EXCEPTION_LOG_INTERVAL_MS = 2000;
  var OWNER_MARKER_ID = "VindictaHudOwner";
  var SNIPE_ELEMENT_CLASSES = ["citadel_ability_hornet_snipe", "Citadel_ability_hornet_snipe", "snipe_power"];
  var LEAP_ELEMENT_CLASSES = ["citadel_ability_hornet_leap", "Citadel_ability_hornet_leap", "leaping"];
  var INSTANCE_CREATED_TIME = Date.now();
  var INSTANCE_TOKEN = INSTANCE_CREATED_TIME.toString(36) + Math.floor(Math.random() * 1e9).toString(36);


  var g_schedulerId = null;
  var g_isShutDown = false;
  var g_hudRoot = null;
  var g_chevronLeft = null;
  var g_chevronRight = null;
  var g_lastDebugLogTime = 0;
  var g_lastDebugState = "";
  var g_stage = "init";
  var g_lastExceptionLogTime = 0;
  var g_suppressedExceptions = 0;

  var g_progressElement = $.GetContextPanel();
  var g_circularProgress = null;
  var g_circularProgressBacker = null;

  var g_scopeImg = null;

  var g_isNativeHidden = false;

  // Flickering and glow variables
  var g_lastFlickerTime = 0;
  var g_cachedCrtShadow = "0px 0px 7.0px 1.0 #39FF14FF";

  // Lock and fire flashing variables
  var g_statusLock = null;
  var g_statusFire = null;

  // Compass variables
  var g_compassPanel = null;
  var g_minimapMainImage = null;

  // Left and right ladders
  var g_ladderLeft = null;
  var g_ladderRight = null;

  // HUD ownership and per-scope session state
  var g_ownerMarker = null;
  var g_isOwner = false;
  var g_session = {
    active: false,
    id: 0,
    startTime: 0,
    lastActiveTime: 0,
    lastProgress: null,
    armed: false,
    firePhase: false
  };

  var SNIPE_BASE_MAX_CHARGES = 2;
  var SNIPE_CHARGE_ICON_WIDTH = 42;
  var SNIPE_CHARGE_ICON_HEIGHT = 32;
  var SNIPE_CHARGE_ICON_GAP = 5;
  var SNIPE_AVAILABLE_TEXTURE = "s2r://panorama/images/hud/crosshair/arm_psd.vtex";
  var SNIPE_SPENT_TEXTURE = "s2r://panorama/images/hud/crosshair/armspent_psd.vtex";
  var SCOPE_BEEP_INTERVAL = 0.535;
  var FIRE_BEEP_INTERVAL = 0.170;
  var ALTITUDE_BEEP_INTERVAL = 2.0;
  var PULLUP_BEEP_INTERVAL = 1.5;
  var SCOPE_LOCK_SOUND = "Hornet.Assassinate.Jetsounds.LockBeep";
  var SCOPE_FIRE_SOUND = "Hornet.Assassinate.Jetsounds.FireBeep";
  var ALTITUDE_BEEP_SOUND = "Hornet.Assassinate.Jetsounds.Altitude";
  var PULLUP_BEEP_SOUND = "Hornet.Assassinate.Jetsounds.PullUp2x";
  var g_snipeChargePanel = null;
  var g_snipeChargeIcons = [];
  var g_snipeChargeImages = [];
  var g_snipeChargeTextures = [];
  var g_snipeMaxObserved = SNIPE_BASE_MAX_CHARGES;
  var g_snipeCurrentObserved = SNIPE_BASE_MAX_CHARGES;
  var g_snipeHasObservedCurrent = false;
  var g_lastSnipeChargeStatus = null;
  var g_snipeAbilityPanel = null;
  var g_snipeAbilityNameDiagnostic = "unknown";
  var g_lastSnipeAbilitySearchTime = 0;
  var g_snipeChargeSearchDiagnostic = "";
  var g_scopeChannel = { eventName: null, interval: 0, nextTime: 0, handles: [] };
  var g_warningChannel = { eventName: null, interval: 0, nextTime: 0, handles: [] };

  function StopChannel(channel) {
    if (typeof StopUISoundEvent === "function") {
      for (var i = 0; i < channel.handles.length; i++) {
        try { StopUISoundEvent(channel.handles[i]); } catch (e) {}
      }
    }
    channel.handles = [];
    channel.eventName = null;
    channel.interval = 0;
    channel.nextTime = 0;
  }

  function SetChannel(channel, eventName, interval) {
    if (!ENABLE_SOUNDS || !eventName) {
      eventName = null;
      interval = 0;
    }
    if (channel.eventName === eventName && channel.interval === interval) return;
    StopChannel(channel);
    channel.eventName = eventName;
    channel.interval = interval;
  }

  // Beeps are played from SyncLoop ticks instead of their own timers, so no sound can outlive the loop.
  function ServiceChannel(channel, now) {
    if (!channel.eventName || now < channel.nextTime || typeof PlayUISoundEvent !== "function") return;
    var handle = null;
    try {
      handle = PlayUISoundEvent(channel.eventName);
    } catch (e) {
      StopChannel(channel);
      return;
    }
    if (handle !== null && handle !== undefined) {
      channel.handles.push(handle);
      if (channel.handles.length > 3) channel.handles.shift();
    }
    var intervalMs = Math.max(16, channel.interval * 1000);
    channel.nextTime = channel.nextTime > 0 ? channel.nextTime + intervalMs : now + intervalMs;
    if (channel.nextTime <= now) channel.nextTime = now + intervalMs;
  }

  function StopAllSounds() {
    StopChannel(g_scopeChannel);
    StopChannel(g_warningChannel);
  }

  function IsValidPanel(p) {
    try {
      return p && p.IsValid && p.IsValid();
    } catch (e) {
      return false;
    }
  }

  function FindHudRoot() {
    var current = g_progressElement;
    var depthLimit = 20;
    while (current && depthLimit > 0) {
      if (current.id === "CitadelHudRoot") return current;
      current = current.GetParent();
      depthLimit--;
    }
    try {
      var uiRoot = $.GetContextPanel();
      var rootDepth = 20;
      while (uiRoot && uiRoot.GetParent() && rootDepth > 0) {
        uiRoot = uiRoot.GetParent();
        rootDepth--;
      }
      if (uiRoot) {
        var localHud = uiRoot.FindChildTraverse("CitadelHudRoot");
        if (localHud) return localHud;
      }
    } catch (e) {}
    return null;
  }

  function GetHudRoot() {
    if (!IsValidPanel(g_hudRoot)) g_hudRoot = FindHudRoot();
    return g_hudRoot;
  }

  function ReadIntegerAttribute(panel, name) {
    try {
      if (panel.GetAttributeInt) {
        var value = panel.GetAttributeInt(name, -1);
        if (typeof value === "number" && value >= 0) return value;
      }
    } catch (e) {}
    try {
      if (panel.GetAttributeString) {
        var text = panel.GetAttributeString(name, "");
        var parsed = parseInt(text, 10);
        if (!isNaN(parsed) && parsed >= 0) return parsed;
      }
    } catch (e) {}
    return null;
  }

  function ReadMaximumSnipeCharges(panel) {
    var dividerContainer = panel.FindChildTraverse("stack_divider_container");
    if (!IsValidPanel(dividerContainer)) return null;

    var dividerCount = 0;
    var dividerChildren = dividerContainer.Children ? dividerContainer.Children() : [];
    for (var d = 0; d < dividerChildren.length; d++) {
      try {
        if (dividerChildren[d].BHasClass && dividerChildren[d].BHasClass("stack_divider")) dividerCount++;
      } catch (e) {}
    }
    return dividerCount > 0 ? dividerCount + 1 : null;
  }

  function FindPanelByClass(root, className) {
    var pending = [root];
    while (pending.length > 0) {
      var current = pending.pop();
      if (!IsValidPanel(current)) continue;
      try {
        if (current.BHasClass && current.BHasClass(className)) return current;
      } catch (e) {}
      var children = current.Children ? current.Children() : [];
      for (var i = 0; i < children.length; i++) pending.push(children[i]);
    }
    return null;
  }

  function FindSnipeAbilityPanel(root) {
    if (IsValidPanel(g_snipeAbilityPanel) && g_snipeAbilityPanel.id === "slot_signature_4") {
      return g_snipeAbilityPanel;
    }

    var signatureSlot = root.FindChildTraverse("slot_signature_4");
    if (IsValidPanel(signatureSlot) &&
        (IsValidPanel(signatureSlot.FindChildTraverse("stack_divider_container")) ||
         IsValidPanel(signatureSlot.FindChildTraverse("charges")))) {
      g_snipeAbilityPanel = signatureSlot;
      g_snipeAbilityNameDiagnostic = "slot_signature_4";
      g_snipeChargeSearchDiagnostic = "matched=slot_signature_4";
      return signatureSlot;
    }

    var activeAbilities = root.FindChildTraverse("ActiveAbilitiesMenu");
    if (IsValidPanel(activeAbilities)) {
      var fallbackButton = null;
      for (var buttonIndex = 0; buttonIndex < 4; buttonIndex++) {
        var button = activeAbilities.FindChildTraverse("abilityButton" + buttonIndex);
        if (!IsValidPanel(button)) continue;
        var nameLabel = FindPanelByClass(button, "ability_name");
        var abilityName = IsValidPanel(nameLabel) ? String(nameLabel.text || "") : "";
        if (buttonIndex === 3) fallbackButton = button;
        if (/snipe|assassinate/i.test(abilityName) && IsValidPanel(button.FindChildTraverse("charges"))) {
          g_snipeAbilityPanel = button;
          g_snipeAbilityNameDiagnostic = abilityName || "matched by slot";
          g_snipeChargeSearchDiagnostic = "matched=" + (button.id || "abilityButton" + buttonIndex) + " name=" + abilityName;
          return button;
        }
      }
      if (IsValidPanel(fallbackButton) && IsValidPanel(fallbackButton.FindChildTraverse("charges"))) {
        var fallbackNameLabel = FindPanelByClass(fallbackButton, "ability_name");
        g_snipeAbilityPanel = fallbackButton;
        g_snipeAbilityNameDiagnostic = IsValidPanel(fallbackNameLabel) ? String(fallbackNameLabel.text || "") : "name-unavailable";
        g_snipeChargeSearchDiagnostic = "fallback=" + (fallbackButton.id || "abilityButton3") + " name=" + g_snipeAbilityNameDiagnostic;
        return fallbackButton;
      }
    }

    var ids = [
      "slot_signature_4",
      "citadel_ability_hornet_snipe",
      "citadel_weapon_hornet_assassinate",
      "ability_hornet_snipe"
    ];
    var now = Date.now();

    if (IsValidPanel(g_snipeAbilityPanel) && IsValidPanel(g_snipeAbilityPanel.FindChildTraverse("charges"))) {
      return g_snipeAbilityPanel;
    }
    g_snipeAbilityPanel = null;
    if ((now - g_lastSnipeAbilitySearchTime) < 1000) return null;
    g_lastSnipeAbilitySearchTime = now;

    var treeRoot = root;
    var parentDepth = 32;
    while (treeRoot && treeRoot.GetParent && parentDepth > 0) {
      var parent = treeRoot.GetParent();
      if (!IsValidPanel(parent)) break;
      treeRoot = parent;
      parentDepth--;
    }
    var searchRoots = [root];
    if (treeRoot !== root) searchRoots.push(treeRoot);

    for (var r = 0; r < searchRoots.length; r++) {
      for (var i = 0; i < ids.length; i++) {
        var panel = searchRoots[r].FindChildTraverse(ids[i]);
        if (IsValidPanel(panel) && IsValidPanel(panel.FindChildTraverse("charges"))) {
          g_snipeAbilityPanel = panel;
          g_snipeChargeSearchDiagnostic = "matched=" + panel.id + " tree=" + (treeRoot.id || "root");
          return panel;
        }
      }
    }

    var pending = [{ panel: treeRoot, depth: 0 }];
    var chargeLabelPaths = [];
    while (pending.length > 0) {
      var entry = pending.pop();
      if (!IsValidPanel(entry.panel) || entry.depth > 40) continue;

      if (entry.panel.id === "charges") {
        var path = [];
        var ancestor = entry.panel.GetParent();
        var matchedAncestor = null;
        for (var a = 0; IsValidPanel(ancestor) && a < 8; a++) {
          var ancestorId = ancestor.id || "";
          path.push(ancestorId || ancestor.paneltype || "Panel");
          if (ids.indexOf(ancestorId) >= 0 || /hornet_snipe|hornet_assassinate|signature_4/i.test(ancestorId)) {
            matchedAncestor = ancestor;
            break;
          }
          ancestor = ancestor.GetParent();
        }
        if (matchedAncestor) {
          g_snipeAbilityPanel = matchedAncestor;
          g_snipeChargeSearchDiagnostic = "matched=" + (matchedAncestor.id || "panel") + " tree=" + (treeRoot.id || "root");
          return matchedAncestor;
        }
        if (chargeLabelPaths.length < 12) {
          chargeLabelPaths.push(path.join("<") + " text=" + entry.panel.text);
        }
      }

      var children = entry.panel.Children ? entry.panel.Children() : [];
      for (var c = 0; c < children.length; c++) {
        pending.push({ panel: children[c], depth: entry.depth + 1 });
      }
    }

    g_snipeChargeSearchDiagnostic = "tree=" + (treeRoot.id || "root") + " chargeLabels=" +
                                    (chargeLabelPaths.length > 0 ? chargeLabelPaths.join(" | ") : "none");
    return null;
  }

  function IsSnipeAbilityActive(root) {
    var abilityPanel = FindSnipeAbilityPanel(root);
    try {
      return IsValidPanel(abilityPanel) && abilityPanel.BHasClass("active");
    } catch (e) {
      return false;
    }
  }

  function LogSnipeChargeStatus(key, detail) {
    if (!DEBUG || key === g_lastSnipeChargeStatus) return;
    g_lastSnipeChargeStatus = key;
    $.Msg("[VindictaSnipeCharges] " + key + " " + detail);
  }

  function ReadCurrentSnipeCharges(panel, label) {
    var panels = [label, panel, IsValidPanel(panel) ? panel.FindChildTraverse("button_container") : null];
    var names = ["charges", "current_charges", "currentCharges", "charge_count"];

    for (var p = 0; p < panels.length; p++) {
      if (!IsValidPanel(panels[p])) continue;
      var text = "";
      try { text = String(panels[p].text || ""); } catch (e) {}
      var parsed = parseInt(text, 10);
      if (!isNaN(parsed) && parsed >= 0) return { value: parsed, source: "text" };

      try {
        if (panels[p].GetAttributeString) {
          var textAttribute = panels[p].GetAttributeString("text", "");
          parsed = parseInt(textAttribute, 10);
          if (!isNaN(parsed) && parsed >= 0) return { value: parsed, source: "text-attribute" };
        }
      } catch (e) {}

      for (var n = 0; n < names.length; n++) {
        var value = ReadIntegerAttribute(panels[p], names[n]);
        if (value !== null) return { value: value, source: "attribute:" + names[n] };
      }
    }
    return null;
  }

  function ReadCurrentSnipeChargesFromStack(panel, maximumCharges) {
    if (!IsValidPanel(panel)) return null;
    var rightSegment = panel.FindChildTraverse("stack_charges_Right");
    if (!IsValidPanel(rightSegment)) return null;

    function ToFiniteNumber(value) {
      if (value === null || value === undefined || value === "") return NaN;
      var number = Number(value);
      return isNaN(number) ? NaN : number;
    }

    var depletedWidth = ToFiniteNumber(rightSegment.actuallayoutwidth);
    if (isNaN(depletedWidth) || depletedWidth < 0) {
      depletedWidth = parseFloat(rightSegment.style.width);
    }
    if (isNaN(depletedWidth) || depletedWidth < 0) return null;

    var position = NaN;
    try { position = parseFloat(rightSegment.style.position); } catch (e) {}
    if (isNaN(position)) {
      try { position = ToFiniteNumber(rightSegment.actuallayoutxoffset); } catch (e) {}
    }
    if (isNaN(position)) {
      try { position = ToFiniteNumber(rightSegment.actualxoffset); } catch (e) {}
    }

    var span = !isNaN(position) && position >= 0 ? position + depletedWidth : 0;
    if (span <= 0) {
      var bar = rightSegment.GetParent ? rightSegment.GetParent() : null;
      if (IsValidPanel(bar)) span = ToFiniteNumber(bar.actuallayoutwidth);
    }
    if (isNaN(span) || span <= 0) span = 89;

    var depletedRatio = Math.max(0, Math.min(1, depletedWidth / span));
    var available = Math.round((1 - depletedRatio) * maximumCharges);
    return {
      value: Math.max(0, Math.min(maximumCharges, available)),
      source: "stack_charges_Right width=" + depletedWidth.toFixed(1) +
              " position=" + (isNaN(position) ? "unknown" : position.toFixed(1)) +
              " span=" + span.toFixed(1)
    };
  }

  function ReadSnipeChargesFromGameApi() {
    try {
      if (typeof Abilities === "undefined" || !Abilities.GetLocalPlayerAbility) return null;
      var abilityIndex = Abilities.GetLocalPlayerAbility(3);
      if (abilityIndex === null || abilityIndex === undefined || abilityIndex < 0) return null;

      var abilityName = Abilities.GetAbilityName ? String(Abilities.GetAbilityName(abilityIndex) || "") : "";
      if (abilityName && !/hornet_snipe|hornet_assassinate/i.test(abilityName)) return null;
      if (!Abilities.GetAbilityCharges) return null;

      var current = Abilities.GetAbilityCharges(abilityIndex);
      if (typeof current !== "number" || isNaN(current) || current < 0) return null;

      var maximum = null;
      if (Abilities.GetAbilityMaxCharges) {
        var apiMaximum = Abilities.GetAbilityMaxCharges(abilityIndex);
        if (typeof apiMaximum === "number" && !isNaN(apiMaximum) && apiMaximum > 0) {
          maximum = apiMaximum;
        }
      }

      return {
        current: current,
        maximum: maximum,
        source: "Abilities.GetLocalPlayerAbility(3)" + (abilityName ? ":" + abilityName : "")
      };
    } catch (e) {
      return null;
    }
  }

  function ResetSnipeChargeIcons(panel) {
    var children = IsValidPanel(panel) && panel.Children ? panel.Children() : [];
    for (var i = 0; i < children.length; i++) {
      if (IsValidPanel(children[i])) children[i].DeleteAsync(0);
    }
    g_snipeChargeIcons = [];
    g_snipeChargeImages = [];
    g_snipeChargeTextures = [];
  }

  function GetOrCreateSnipeChargePanel(root) {
    if (IsValidPanel(g_snipeChargePanel)) return g_snipeChargePanel;

    var existing = root.FindChildTraverse("VindictaSnipeChargeStack");
    if (IsValidPanel(existing)) {
      g_snipeChargePanel = existing;
      // Rebuild instead of adopting icons, so no reference to a panel deleted elsewhere can survive.
      ResetSnipeChargeIcons(existing);
      return g_snipeChargePanel;
    }

    var panel = $.CreatePanel("Panel", root, "VindictaSnipeChargeStack");
    panel.style.horizontalAlign = "center";
    panel.style.verticalAlign = "center";
    panel.style.marginLeft = "-30%";
    panel.style.marginTop = "-5%";
    panel.style.width = SNIPE_CHARGE_ICON_WIDTH + "px";
    panel.style.height = SNIPE_CHARGE_ICON_HEIGHT + "px";
    panel.style.flowChildren = "down";
    panel.style.transform = "translateY(20px)";
    panel.style.overflow = "noclip";
    panel.style.zIndex = "1000";
    panel.hittest = false;
    panel.style.visibility = "visible";
    panel.style.opacity = "1.0";

    g_snipeChargePanel = panel;
    ResetSnipeChargeIcons(panel);
    return g_snipeChargePanel;
  }

  function UpdateSnipeChargeIndicators(root, showIndicators) {
    var panel = GetOrCreateSnipeChargePanel(root);
    var abilityPanel = FindSnipeAbilityPanel(root);
    var chargesLabel = IsValidPanel(abilityPanel) ? abilityPanel.FindChildTraverse("charges") : null;
    var reportedMaximum = IsValidPanel(abilityPanel) ? ReadMaximumSnipeCharges(abilityPanel) : null;
    var maximumCharges = reportedMaximum !== null ? Math.max(reportedMaximum, g_snipeHasObservedCurrent ? g_snipeCurrentObserved : 0) :
               Math.max(g_snipeMaxObserved, SNIPE_BASE_MAX_CHARGES, g_snipeHasObservedCurrent ? g_snipeCurrentObserved : 0);
    var currentCharges = g_snipeHasObservedCurrent ? g_snipeCurrentObserved : maximumCharges;
    var currentChargeSource = g_snipeHasObservedCurrent ? "last-known" : "assume-full-until-count-readable";
    var chargeSource = "fallback";
    if (reportedMaximum !== null) {
      g_snipeMaxObserved = maximumCharges;
      chargeSource = "stack-divider:max=" + reportedMaximum;
    }
    var stackChargeReading = ReadCurrentSnipeChargesFromStack(abilityPanel, maximumCharges);
    var apiCharges = stackChargeReading ? null : ReadSnipeChargesFromGameApi();

    if (stackChargeReading) {
      currentCharges = stackChargeReading.value;
      g_snipeCurrentObserved = currentCharges;
      g_snipeHasObservedCurrent = true;
      currentChargeSource = stackChargeReading.source;
      g_snipeMaxObserved = maximumCharges;
      chargeSource = "stack-divider:max=" + maximumCharges;
    } else if (apiCharges) {
      currentCharges = apiCharges.current;
      g_snipeCurrentObserved = currentCharges;
      g_snipeHasObservedCurrent = true;
      currentChargeSource = apiCharges.source;
      maximumCharges = apiCharges.maximum !== null ? Math.max(apiCharges.maximum, currentCharges) :
                       Math.max(maximumCharges, g_snipeMaxObserved, SNIPE_BASE_MAX_CHARGES, currentCharges);
      g_snipeMaxObserved = maximumCharges;
      chargeSource = apiCharges.source;
    } else if (IsValidPanel(abilityPanel) && IsValidPanel(chargesLabel)) {
      var chargeReading = ReadCurrentSnipeCharges(abilityPanel, chargesLabel);
      if (chargeReading) {
        currentCharges = chargeReading.value;
        g_snipeCurrentObserved = currentCharges;
        g_snipeHasObservedCurrent = true;
        currentChargeSource = chargeReading.source;

        maximumCharges = Math.max(maximumCharges, g_snipeMaxObserved, SNIPE_BASE_MAX_CHARGES, currentCharges);
        g_snipeMaxObserved = maximumCharges;
        chargeSource = (abilityPanel.id || "abilityButton3") + "#charges(" + chargeReading.source + ") name=" + g_snipeAbilityNameDiagnostic;
      } else {
        var labelText = "";
        try { labelText = String(chargesLabel.text || ""); } catch (e) {}
        chargeSource = "unreadable-count button=" + (abilityPanel.id || "unknown") +
                       " name=" + g_snipeAbilityNameDiagnostic +
                       " label='" + labelText + "' " + g_snipeChargeSearchDiagnostic;
      }
    } else if (IsValidPanel(abilityPanel)) {
      chargeSource = "missing-label:" + abilityPanel.id;
    } else {
      chargeSource = "panel-not-found " + g_snipeChargeSearchDiagnostic;
    }

    for (var v = 0; v < g_snipeChargeIcons.length; v++) {
      if (!IsValidPanel(g_snipeChargeIcons[v]) || !IsValidPanel(g_snipeChargeImages[v])) {
        ResetSnipeChargeIcons(panel);
        break;
      }
    }
    while (g_snipeChargeIcons.length < maximumCharges) {
      var iconIndex = g_snipeChargeIcons.length;
      var icon = $.CreatePanel("Panel", panel, "VindictaSnipeCharge_" + iconIndex);
      var iconImage = $.CreatePanel("Image", icon, "VindictaSnipeChargeImage_" + iconIndex);
      try {
        if (iconImage.SetScaling) iconImage.SetScaling("stretch-to-fit-preserve-aspect");
      } catch (e) {}
      g_snipeChargeIcons.push(icon);
      g_snipeChargeImages.push(iconImage);
      g_snipeChargeTextures.push(null);
    }
    while (g_snipeChargeIcons.length > maximumCharges) {
      var removedIcon = g_snipeChargeIcons.pop();
      g_snipeChargeImages.pop();
      g_snipeChargeTextures.pop();
      if (IsValidPanel(removedIcon)) removedIcon.DeleteAsync(0);
    }

    panel.style.width = SNIPE_CHARGE_ICON_WIDTH + "px";
    panel.style.height = (maximumCharges * (SNIPE_CHARGE_ICON_HEIGHT + SNIPE_CHARGE_ICON_GAP)) + "px";
    panel.style.horizontalAlign = "center";
    panel.style.verticalAlign = "center";
    panel.style.marginLeft = "-30%";
    panel.style.marginTop = "-5%";
    panel.style.transform = "translateY(20px)";
    panel.style.flowChildren = "down";
    panel.style.zIndex = "1000";
    panel.style.visibility = "visible";
    panel.style.opacity = showIndicators ? "1.0" : "0.0";
    for (var i = 0; i < g_snipeChargeIcons.length; i++) {
      var chargeIcon = g_snipeChargeIcons[i];
      chargeIcon.style.width = SNIPE_CHARGE_ICON_WIDTH + "px";
      chargeIcon.style.height = SNIPE_CHARGE_ICON_HEIGHT + "px";
      chargeIcon.style.marginBottom = SNIPE_CHARGE_ICON_GAP + "px";
      chargeIcon.style.backgroundImage = null;
      chargeIcon.style.visibility = "visible";
      chargeIcon.style.opacity = showIndicators ? "1.0" : "0.0";

      var chargeImage = g_snipeChargeImages[i];
      var texture = i < currentCharges ? SNIPE_AVAILABLE_TEXTURE : SNIPE_SPENT_TEXTURE;
      if (g_snipeChargeTextures[i] !== texture) {
        chargeImage.SetImage(texture);
        g_snipeChargeTextures[i] = texture;
      }
      chargeImage.style.width = "100%";
      chargeImage.style.height = "100%";
      chargeImage.style.horizontalAlign = "center";
      chargeImage.style.verticalAlign = "center";
      chargeImage.style.visibility = "visible";
      chargeImage.style.washColor = "#00FF66";
      chargeImage.style.imgShadow = g_cachedCrtShadow;
    }
    LogSnipeChargeStatus("current=" + currentCharges + " max=" + maximumCharges +
                         " panel=" + (IsValidPanel(abilityPanel) ? abilityPanel.id : "missing") +
                         " shown=" + showIndicators,
                         "source=" + chargeSource + " currentSource=" + currentChargeSource);
  }

  function HideSnipeChargeIndicators() {
    if (IsValidPanel(g_snipeChargePanel)) g_snipeChargePanel.style.opacity = "0.0";
  }

  function GetMinimapYaw(root) {
    try {
      if (!IsValidPanel(g_minimapMainImage)) {
        var minimap = root.FindChildTraverse("hud_minimap");
        if (minimap) {
          g_minimapMainImage = minimap.FindChildTraverse("MainImage");
        }
      }

      if (IsValidPanel(g_minimapMainImage)) {
        var m = g_minimapMainImage;
        var styleStr = (m.style && m.style.transform) ? m.style.transform : "";
        if (styleStr) {
          var matches = styleStr.match(/rotate3d\s*\(\s*(-?\d+(?:\.\d+)?)deg\s*,\s*(-?\d+(?:\.\d+)?)deg\s*,\s*(-?\d+(?:\.\d+)?)deg\s*\)/i);
          if (matches && matches.length >= 4) {
            var yawDeg = parseFloat(matches[2]); 
            if (!isNaN(yawDeg)) return yawDeg;
          }
          var fallbackMatches = styleStr.match(/rotate[YZ]\s*\(\s*(-?\d+(?:\.\d+)?)deg\s*\)/i);
          if (fallbackMatches && fallbackMatches[1]) {
            return parseFloat(fallbackMatches[1]);
          }
        }
      }
    } catch (e) {}

    return 0.0;
  }

  function HasPanelClass(panel, className) {
    try {
      return IsValidPanel(panel) && panel.BHasClass && panel.BHasClass(className);
    } catch (e) {
      return false;
    }
  }

  var g_flightElement = null;
  var g_flightClippedLabel = null;
  var g_flightSearchRoot = null;
  var g_lastFlightSearchTime = 0;
  var g_flightLastRatio = null;
  var g_flightLastChangeTime = 0;

  function IsLeapElement(panel) {
    for (var i = 0; i < LEAP_ELEMENT_CLASSES.length; i++) {
      if (HasPanelClass(panel, LEAP_ELEMENT_CLASSES[i])) return true;
    }
    return false;
  }

  function ResetFlightTracking() {
    g_flightLastRatio = null;
    g_flightLastChangeTime = 0;
  }

  function ResetFlightLookup() {
    g_flightElement = null;
    g_flightClippedLabel = null;
    g_lastFlightSearchTime = 0;
    ResetFlightTracking();
  }

  // Ability elements all share the id "progress", so the leap element is matched by class instead.
  function FindFlightDurationLabel(root, now) {
    if (IsValidPanel(g_flightClippedLabel) && IsLeapElement(g_flightElement)) return g_flightClippedLabel;
    if (g_flightClippedLabel) LogDebug("flight element lost");
    g_flightElement = null;
    g_flightClippedLabel = null;
    if ((now - g_lastFlightSearchTime) < FLIGHT_SEARCH_INTERVAL_MS) return null;
    g_lastFlightSearchTime = now;

    if (!IsValidPanel(g_flightSearchRoot)) {
      var gameplayHud = root.FindChildTraverse("gameplay_hud");
      var crosshair = IsValidPanel(gameplayHud) ? gameplayHud.FindChildTraverse("crosshair") : null;
      g_flightSearchRoot = IsValidPanel(crosshair) ? crosshair : gameplayHud;
    }
    if (!IsValidPanel(g_flightSearchRoot)) return null;

    var pending = [g_flightSearchRoot];
    for (var visited = 0; pending.length > 0 && visited < 3000; visited++) {
      var panel = pending.pop();
      if (!IsValidPanel(panel)) continue;
      if (IsLeapElement(panel)) {
        var label = panel.FindChildTraverse("ability_name_clipped");
        if (IsValidPanel(label)) {
          g_flightElement = panel;
          g_flightClippedLabel = label;
          ResetFlightTracking();
          LogDebug("flight element found id=" + panel.id);
          return label;
        }
      }
      var children = panel.Children ? panel.Children() : [];
      for (var c = 0; c < children.length; c++) pending.push(children[c]);
    }
    return null;
  }

  function ReadFlightDurationProgress(clippedLabel) {
    try {
      if (IsValidPanel(clippedLabel) && clippedLabel.style && clippedLabel.style.clip) {
        var matches = String(clippedLabel.style.clip).match(/(\d+(?:\.\d+)?)%/g);
        if (matches && matches.length >= 2) {
          var elapsedPercent = parseFloat(matches[1]);
          if (!isNaN(elapsedPercent)) {
            var elapsedRatio = Math.max(0.0, Math.min(1.0, elapsedPercent / 100.0));
            return elapsedRatio >= 1.0 - FLIGHT_COMPLETE_EPSILON ? 1.0 : elapsedRatio;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  // Graphic metrics for 0to9_psd.vtex & altbox_psd.vtex
  var ODOMETER_CONFIG = {
    CHAR_HEIGHT: 36.0, 
    SPACING: 8.0,      
    STRIDE: 44.0,      
    OFFSET_Y: 0.0,     
    WIDTH: 24,         
    NUM_DIGITS: 4,
    TOTAL_CANVAS_HEIGHT: 432, 
    TEXTURE: "s2r://panorama/images/hud/crosshair/0to9_psd.vtex",
    BOX_TEXTURE: "s2r://panorama/images/hud/crosshair/altbox_psd.vtex",
    ALT_TEXTURE: "s2r://panorama/images/hud/crosshair/alt_psd.vtex",
    PULLUP_TEXTURE: "s2r://panorama/images/hud/crosshair/pullup_psd.vtex",
    BOX_WIDTH: 140,
    BOX_HEIGHT: 50
  };

  var g_altimeterDisplay = {
    container: null,
    boxImage: null,
    altImage: null,
    pullUpImage: null,
    strips: [],
    warningMode: null,
    warningStartTime: 0,

    GetOrCreate: function (root) {
      function CreateWarningImage(parent, id, texture) {
        var image = $.CreatePanel("Image", parent, id);
        image.SetImage(texture);
        image.style.horizontalAlign = "center";
        image.style.verticalAlign = "top";
        image.style.marginTop = ODOMETER_CONFIG.BOX_HEIGHT + "px";
        image.style.width = "125px";
        image.style.height = "40px";
        image.style.opacity = "0.0";
        return image;
      }

      if (IsValidPanel(this.container)) return this.container;

      var existing = root.FindChildTraverse("VindictaAltimeterDisplay");
      if (existing) {
        this.container = existing;
        this.boxImage = existing.FindChildTraverse("AltimeterBoxFrame");
        this.altImage = existing.FindChildTraverse("AltimeterAltWarning");
        this.pullUpImage = existing.FindChildTraverse("AltimeterPullUpWarning");
        if (!IsValidPanel(this.altImage)) {
          this.altImage = CreateWarningImage(existing, "AltimeterAltWarning", ODOMETER_CONFIG.ALT_TEXTURE);
        }
        if (!IsValidPanel(this.pullUpImage)) {
          this.pullUpImage = CreateWarningImage(existing, "AltimeterPullUpWarning", ODOMETER_CONFIG.PULLUP_TEXTURE);
        }
        existing.style.height = "90px";
        existing.style.transform = "translateY(20px)";
        if (IsValidPanel(this.boxImage)) {
          this.boxImage.style.height = ODOMETER_CONFIG.BOX_HEIGHT + "px";
          this.boxImage.style.verticalAlign = "top";
        }
        var existingDigitGroup = existing.FindChildTraverse("AltimeterDigitGroup");
        if (IsValidPanel(existingDigitGroup)) {
          existingDigitGroup.style.verticalAlign = "top";
          existingDigitGroup.style.marginTop = "7px";
        }
        this.strips = [];
        for (var i = 0; i < ODOMETER_CONFIG.NUM_DIGITS; i++) {
          var strip = existing.FindChildTraverse("OdometerStrip_" + i);
          if (strip) this.strips.push(strip);
        }
        return this.container;
      }

      var container = $.CreatePanel("Panel", root, "VindictaAltimeterDisplay");
      container.style.horizontalAlign = "center";
      container.style.verticalAlign = "center";
      container.style.marginLeft = "40%"; 
      container.style.width = ODOMETER_CONFIG.BOX_WIDTH + "px";
      container.style.height = "90px";
      container.style.transform = "translateY(20px)";
      container.style.opacity = "0.0";
      container.style.overflow = "noclip";

      var boxImage = $.CreatePanel("Image", container, "AltimeterBoxFrame");
      boxImage.SetImage(ODOMETER_CONFIG.BOX_TEXTURE);
      boxImage.style.width = "100%";
      boxImage.style.height = ODOMETER_CONFIG.BOX_HEIGHT + "px";
      boxImage.style.verticalAlign = "top";
      boxImage.style.marginLeft = "-10%";

      var totalDigitsWidth = ODOMETER_CONFIG.WIDTH * ODOMETER_CONFIG.NUM_DIGITS; 
      
      var digitGroup = $.CreatePanel("Panel", container, "AltimeterDigitGroup");
      digitGroup.style.width = totalDigitsWidth + "px"; 
      digitGroup.style.height = ODOMETER_CONFIG.CHAR_HEIGHT + "px"; 
      digitGroup.style.horizontalAlign = "center"; 
      digitGroup.style.verticalAlign = "top";
      digitGroup.style.marginTop = "7px";
      digitGroup.style.flowChildren = "right";

      this.strips = [];

      for (var d = 0; d < ODOMETER_CONFIG.NUM_DIGITS; d++) {
        var slot = $.CreatePanel("Panel", digitGroup, "OdometerSlot_" + d);
        slot.style.width = ODOMETER_CONFIG.WIDTH + "px";
        slot.style.height = ODOMETER_CONFIG.CHAR_HEIGHT + "px";
        slot.style.overflow = "clip";

        var strip = $.CreatePanel("Panel", slot, "OdometerStrip_" + d);
        strip.style.width = "100%";
        strip.style.height = "100%";
        strip.style.backgroundImage = "url('" + ODOMETER_CONFIG.TEXTURE + "')";
        strip.style.backgroundSize = ODOMETER_CONFIG.WIDTH + "px " + ODOMETER_CONFIG.TOTAL_CANVAS_HEIGHT + "px";
        strip.style.backgroundRepeat = "no-repeat";

        this.strips.push(strip);
      }

      this.altImage = CreateWarningImage(container, "AltimeterAltWarning", ODOMETER_CONFIG.ALT_TEXTURE);
      this.pullUpImage = CreateWarningImage(container, "AltimeterPullUpWarning", ODOMETER_CONFIG.PULLUP_TEXTURE);
      this.boxImage = boxImage;
      this.container = container;
      return this.container;
    },

    Update: function (value, crtShadow) {
      if (!IsValidPanel(this.container)) return;

      var val = Math.max(0, value);
      
      var d3 = val % 10;
      var d2 = (Math.floor(val / 10) % 10) + (d3 >= 9 ? (d3 - 9) : 0);
      var d1 = (Math.floor(val / 100) % 10) + (d2 >= 9.9 ? (d3 - 9) : 0);
      var d0 = (Math.floor(val / 1000) % 10) + (d1 >= 9.9 ? (d3 - 9) : 0);

      var digitValues = [d0, d1, d2, d3];

      for (var i = 0; i < ODOMETER_CONFIG.NUM_DIGITS; i++) {
        var digitVal = digitValues[i];
        var strip = this.strips[i];

        if (IsValidPanel(strip)) {
          var offsetY = -(digitVal * ODOMETER_CONFIG.STRIDE) + ODOMETER_CONFIG.OFFSET_Y;
          
          strip.style.backgroundPosition = "0px " + offsetY.toFixed(2) + "px";
          strip.style.washColor = "#00FF66";
          strip.style.imgShadow = crtShadow;
        }
      }

      if (IsValidPanel(this.boxImage)) {
        this.boxImage.style.washColor = "#00FF66";
        this.boxImage.style.imgShadow = crtShadow;
      }

      if (IsValidPanel(this.altImage) && IsValidPanel(this.pullUpImage)) {
        var now = Date.now();
        var warningMode = val > 3500 && val <= 7500 ? "altitude" :
                          val > 0 && val <= 3500 ? "pullup" : null;

        if (warningMode !== this.warningMode) {
          this.warningMode = warningMode;
          this.warningStartTime = now;

          if (warningMode === "altitude") {
            SetChannel(g_warningChannel, ALTITUDE_BEEP_SOUND, ALTITUDE_BEEP_INTERVAL);
          } else if (warningMode === "pullup") {
            SetChannel(g_warningChannel, PULLUP_BEEP_SOUND, PULLUP_BEEP_INTERVAL);
          } else {
            SetChannel(g_warningChannel, null, 0.0);
          }
        }

        this.altImage.style.washColor = "#00FF66";
        this.altImage.style.imgShadow = crtShadow;
        this.pullUpImage.style.washColor = "#00FF66";
        this.pullUpImage.style.imgShadow = crtShadow;

        var warningElapsed = now - this.warningStartTime;
        if (warningMode === "altitude") {
          this.altImage.style.opacity = (warningElapsed % 800) < 400 ? "1.0" : "0.0";
          this.pullUpImage.style.opacity = "0.0";
        } else if (warningMode === "pullup") {
          this.altImage.style.opacity = "0.0";
          this.pullUpImage.style.opacity = (warningElapsed % 500) < 250 ? "1.0" : "0.0";
        } else {
          this.altImage.style.opacity = "0.0";
          this.pullUpImage.style.opacity = "0.0";
        }
      }

      this.container.style.opacity = "1.0";
    },

    Hide: function () {
      if (IsValidPanel(this.container)) {
        this.container.style.opacity = "0.0";
      }
      if (IsValidPanel(this.altImage)) this.altImage.style.opacity = "0.0";
      if (IsValidPanel(this.pullUpImage)) this.pullUpImage.style.opacity = "0.0";
      this.ResetWarning();
    },

    ResetWarning: function () {
      StopChannel(g_warningChannel);
      this.warningMode = null;
      this.warningStartTime = 0;
    },

    DropRefs: function () {
      this.container = null;
      this.boxImage = null;
      this.altImage = null;
      this.pullUpImage = null;
      this.strips = [];
      this.ResetWarning();
    }
  };

  function GetOrCreateCompassPanel(root) {
    if (IsValidPanel(g_compassPanel)) return g_compassPanel;

    var oldViewport = root.FindChildTraverse("VindictaCompassViewport");
    if (oldViewport) oldViewport.DeleteAsync(0);

    var existingTape = root.FindChildTraverse("VindictaCompassTape");
    if (existingTape) {
      g_compassPanel = existingTape;
      return g_compassPanel;
    }

    var panel = $.CreatePanel("Panel", root, "VindictaCompassTape");
    panel.style.horizontalAlign = "center";
    panel.style.verticalAlign = "top";
    panel.style.marginTop = "150px";

    panel.style.width = "56%";
    panel.style.height = "45px";

    panel.style.backgroundImage = "url('s2r://panorama/images/hud/crosshair/compass_psd.vtex')";
    panel.style.backgroundSize = "4872px 45px";
    panel.style.backgroundRepeat = "no-repeat";

    panel.style.visibility = "collapse";
    panel.style.opacity = "0.0";
    panel.visible = false;

    g_compassPanel = panel;
    return g_compassPanel;
  }

  function CreateOverlayImage(parent, id, texture, width, height, transform) {
    var image = $.CreatePanel("Image", parent, id);
    image.SetImage(texture);
    image.style.horizontalAlign = "center";
    image.style.verticalAlign = "center";
    if (transform) image.style.transform = transform;
    image.style.width = width;
    image.style.height = height;
    image.style.opacity = "0.0";
    return image;
  }

  // Each panel is resolved on its own so a half-missing pair never spawns duplicates.
  function FindOrCreateOverlayImage(parent, id, texture, width, height, transform) {
    var existing = parent.FindChildTraverse(id);
    return IsValidPanel(existing) ? existing : CreateOverlayImage(parent, id, texture, width, height, transform);
  }

  function GetOrCreateLadderPanels(root) {
    var texture = "s2r://panorama/images/hud/crosshair/ladder_psd.vtex";
    if (!IsValidPanel(g_ladderLeft)) {
      g_ladderLeft = FindOrCreateOverlayImage(root, "VindictaLadderLeft", texture, "76px", "1344px", "translateX(-30%)");
      g_ladderLeft.style.overflow = "noclip";
    }
    if (!IsValidPanel(g_ladderRight)) {
      g_ladderRight = FindOrCreateOverlayImage(root, "VindictaLadderRight", texture, "76px", "1344px", "translateX(30%)");
      g_ladderRight.style.overflow = "noclip";
    }
    return { left: g_ladderLeft, right: g_ladderRight };
  }

  function GetLocalProgressPanels() {
    if (!IsValidPanel(g_circularProgress) || !IsValidPanel(g_circularProgressBacker)) {
      g_circularProgress = g_progressElement.FindChildInLayoutFile("circular_progress");
      g_circularProgressBacker = g_progressElement.FindChildInLayoutFile("circular_progress_backer");
    }
    return { progress: g_circularProgress, backer: g_circularProgressBacker };
  }

  function GetScopeImg(root) {
    if (IsValidPanel(g_scopeImg)) return g_scopeImg;
    g_scopeImg = root.FindChildTraverse("scope_img");
    return g_scopeImg;
  }

  // Returns null when unreadable so callers hold the last value instead of snapping to zero.
  function ReadProgressValue(localProgress) {
    try {
      if (typeof localProgress.value === "number" && !isNaN(localProgress.value)) return localProgress.value;
      if (typeof localProgress.progress === "number" && !isNaN(localProgress.progress)) return localProgress.progress;
      var clip = localProgress.style ? localProgress.style.clip : null;
      if (clip) {
        var matches = String(clip).match(/(\d+(\.\d+)?)deg/g);
        if (matches && matches.length > 0) {
          var endAngleDeg = parseFloat(matches[matches.length - 1]);
          if (!isNaN(endAngleDeg)) return endAngleDeg / 360.0;
        }
      }
    } catch (e) {}
    return null;
  }

  function GetOrCreateChevronPanels(scopeImg) {
    if (!IsValidPanel(g_chevronLeft)) {
      g_chevronLeft = FindOrCreateOverlayImage(scopeImg, "VindictaChevronLeft",
        "s2r://panorama/images/hud/crosshair/chevron_left_psd.vtex", "128px", "128px", null);
    }
    if (!IsValidPanel(g_chevronRight)) {
      g_chevronRight = FindOrCreateOverlayImage(scopeImg, "VindictaChevronRight",
        "s2r://panorama/images/hud/crosshair/chevron_right_psd.vtex", "128px", "128px", null);
    }
    return { left: g_chevronLeft, right: g_chevronRight };
  }

  function HideNativeProgress(localProgress, localBacker) {
    var changed = false;
    if (localProgress && localProgress.style && localProgress.style.opacity !== "0.001") {
      localProgress.style.opacity = "0.001";
      localProgress.style.transform = null;
      changed = true;
    }
    if (localBacker && localBacker.style && localBacker.style.opacity !== "0.001") {
      localBacker.style.opacity = "0.001";
      localBacker.style.transform = null;
      changed = true;
    }
    if (changed) g_isNativeHidden = true;
  }

  function RestoreNativeProgress(localProgress, localBacker) {
    var changed = false;
    if (localProgress && localProgress.style && localProgress.style.opacity === "0.001") {
      localProgress.style.opacity = "1.0";
      changed = true;
    }
    if (localBacker && localBacker.style && localBacker.style.opacity === "0.001") {
      localBacker.style.opacity = "1.0";
      changed = true;
    }
    if (changed) g_isNativeHidden = false;
  }

  function GetOrCreateStatusPanels(scopeImg) {
    if (!IsValidPanel(g_statusLock)) {
      g_statusLock = FindOrCreateOverlayImage(scopeImg, "VindictaStatusLock",
        "s2r://panorama/images/hud/crosshair/lock_psd.vtex", "64px", "32px", "translateY(50px)");
    }
    if (!IsValidPanel(g_statusFire)) {
      g_statusFire = FindOrCreateOverlayImage(scopeImg, "VindictaStatusFire",
        "s2r://panorama/images/hud/crosshair/fire_psd.vtex", "64px", "32px", "translateY(50px)");
    }
    return { lock: g_statusLock, fire: g_statusFire };
  }

  function LogDebug(message) {
    if (DEBUG) $.Msg("[VindictaMask " + INSTANCE_TOKEN + "] " + message);
  }

  function ReportException(e) {
    var now = Date.now();
    if ((now - g_lastExceptionLogTime) < EXCEPTION_LOG_INTERVAL_MS) {
      g_suppressedExceptions++;
      return;
    }
    $.Msg("[VindictaMask] EXCEPTION in " + g_stage + ": " + e +
          (g_suppressedExceptions > 0 ? " (" + g_suppressedExceptions + " repeats suppressed)" : ""));
    g_lastExceptionLogTime = now;
    g_suppressedExceptions = 0;
  }

  function DescribeElementClasses() {
    var names = SNIPE_ELEMENT_CLASSES.concat(["hero_" + VINDICTA_HERO_NAME, "ability_element_progress"]);
    var present = [];
    for (var i = 0; i < names.length; i++) {
      if (HasPanelClass(g_progressElement, names[i])) present.push(names[i]);
    }
    return present.length > 0 ? present.join(",") : "none";
  }

  // 17 abilities share this layout, so each script copy checks that its own element is Vindicta's Snipe.
  function GetElementStrength() {
    for (var i = 0; i < SNIPE_ELEMENT_CLASSES.length; i++) {
      if (HasPanelClass(g_progressElement, SNIPE_ELEMENT_CLASSES[i])) return 3;
    }
    var heroClass = "hero_" + VINDICTA_HERO_NAME;
    if (HasPanelClass(g_progressElement, heroClass)) return 2;
    var ancestor = g_progressElement.GetParent();
    for (var depth = 0; IsValidPanel(ancestor) && depth < 24; depth++) {
      if (HasPanelClass(ancestor, heroClass)) return 1;
      if (ancestor.id === "CitadelHudRoot") break;
      ancestor = ancestor.GetParent();
    }
    return 0;
  }

  function GetOwnerMarker(root) {
    if (IsValidPanel(g_ownerMarker)) return g_ownerMarker;
    var marker = root.FindChildTraverse(OWNER_MARKER_ID);
    if (!IsValidPanel(marker)) {
      marker = $.CreatePanel("Label", root, OWNER_MARKER_ID);
      marker.text = "";
      marker.hittest = false;
      marker.visible = false;
    }
    g_ownerMarker = marker;
    return marker;
  }

  function ReadOwnerClaim(marker) {
    var parts = String(marker.text || "").split("|");
    if (parts.length !== 4) return null;
    return {
      token: parts[0],
      strength: parseInt(parts[1], 10) || 0,
      heartbeat: parseFloat(parts[2]) || 0,
      created: parseFloat(parts[3]) || 0
    };
  }

  // Script copies share no memory, so the claim lives on a hidden label under the HUD root.
  function ClaimOwnership(root, strength, now) {
    var marker = GetOwnerMarker(root);
    var claim = ReadOwnerClaim(marker);
    var isMine = claim !== null && claim.token === INSTANCE_TOKEN;
    var claimAlive = claim !== null && (now - claim.heartbeat) < OWNER_TIMEOUT_MS;
    if (claimAlive && !isMine) {
      var outranks = strength > claim.strength ||
                     (strength === claim.strength && INSTANCE_CREATED_TIME > claim.created);
      if (!outranks) return false;
    }
    if (isMine && claimAlive && claim.strength === strength && (now - claim.heartbeat) < OWNER_TIMEOUT_MS / 4) {
      return true;
    }
    marker.text = INSTANCE_TOKEN + "|" + strength + "|" + now + "|" + INSTANCE_CREATED_TIME;
    return true;
  }

  function ReleaseOwnership() {
    try {
      if (IsValidPanel(g_ownerMarker)) {
        var claim = ReadOwnerClaim(g_ownerMarker);
        if (claim && claim.token === INSTANCE_TOKEN) g_ownerMarker.text = "";
      }
    } catch (e) {}
    g_isOwner = false;
  }

  function DropScopeCaches() {
    g_scopeImg = null;
    g_chevronLeft = null;
    g_chevronRight = null;
    g_statusLock = null;
    g_statusFire = null;
  }

  function DropPanelCaches() {
    DropScopeCaches();
    g_hudRoot = null;
    g_ladderLeft = null;
    g_ladderRight = null;
    g_compassPanel = null;
    g_minimapMainImage = null;
    g_ownerMarker = null;
    g_circularProgress = null;
    g_circularProgressBacker = null;
    g_snipeAbilityPanel = null;
    g_snipeChargePanel = null;
    g_snipeChargeIcons = [];
    g_snipeChargeImages = [];
    g_snipeChargeTextures = [];
    g_flightSearchRoot = null;
    ResetFlightLookup();
    g_altimeterDisplay.DropRefs();
  }

  function SetOpacityIfValid(panel, opacity) {
    if (IsValidPanel(panel)) panel.style.opacity = opacity;
  }

  function HideOverlay() {
    if (IsValidPanel(g_scopeImg)) {
      g_scopeImg.style.backgroundImage = null;
      g_scopeImg.style.washColor = null;
      g_scopeImg.style.imgShadow = null;
    }
    SetOpacityIfValid(g_chevronLeft, "0.0");
    SetOpacityIfValid(g_chevronRight, "0.0");
    SetOpacityIfValid(g_statusLock, "0.0");
    SetOpacityIfValid(g_statusFire, "0.0");
    SetOpacityIfValid(g_ladderLeft, "0.0");
    SetOpacityIfValid(g_ladderRight, "0.0");
    if (IsValidPanel(g_compassPanel)) g_compassPanel.DeleteAsync(0);
    g_compassPanel = null;
    g_altimeterDisplay.Hide();
    HideSnipeChargeIndicators();
  }

  // A previous owner may have died mid-scope, so its panels are looked up by id and hidden.
  function AdoptExistingOverlay(root) {
    g_scopeImg = root.FindChildTraverse("scope_img");
    if (IsValidPanel(g_scopeImg)) {
      g_chevronLeft = g_scopeImg.FindChildTraverse("VindictaChevronLeft");
      g_chevronRight = g_scopeImg.FindChildTraverse("VindictaChevronRight");
      g_statusLock = g_scopeImg.FindChildTraverse("VindictaStatusLock");
      g_statusFire = g_scopeImg.FindChildTraverse("VindictaStatusFire");
    }
    g_ladderLeft = root.FindChildTraverse("VindictaLadderLeft");
    g_ladderRight = root.FindChildTraverse("VindictaLadderRight");
    g_compassPanel = root.FindChildTraverse("VindictaCompassTape");
    g_altimeterDisplay.GetOrCreate(root);
    HideOverlay();
  }

  function BeginScopeSession(now) {
    StopAllSounds();
    g_session.active = true;
    g_session.id++;
    g_session.startTime = now;
    g_session.lastActiveTime = now;
    g_session.lastProgress = null;
    g_session.armed = false;
    g_session.firePhase = false;
    g_altimeterDisplay.ResetWarning();
    DropScopeCaches();
    ResetFlightLookup();
    LogDebug("scope session " + g_session.id + " begin");
  }

  function EndScopeSession() {
    StopAllSounds();
    if (g_session.active) LogDebug("scope session " + g_session.id + " end");
    g_session.active = false;
    g_session.firePhase = false;
    HideOverlay();
  }

  function StandDown() {
    if (g_isOwner || g_session.active) EndScopeSession();
    if (g_isOwner) {
      ReleaseOwnership();
      LogDebug("released HUD ownership");
    }
    StopAllSounds();
  }

  function UpdateCrtShadow(now) {
    if (g_lastFlickerTime && (now - g_lastFlickerTime) <= 30) return;
    g_lastFlickerTime = now;
    var baseBlur = 7.0;
    var blurJitter = (Math.random() * 1.6) - 0.8;
    var currentBlur = (baseBlur + blurJitter).toFixed(1);
    var flickerAlpha = (Math.random() > 0.88) ? "E6" : "FF";
    g_cachedCrtShadow = "0px 0px " + currentBlur + "px 1.0 #39FF14" + flickerAlpha;
  }

  // Hysteresis keeps a small dip in charge from flipping LOCK and FIRE back and forth.
  function UpdateLockState(progress, now) {
    var session = g_session;
    if (progress === null) progress = session.lastProgress;
    session.lastProgress = progress;
    if (progress === null) return { closure: 0.0, fire: false };

    // A high reading right after scope-in can be left over from the previous scope.
    if (!session.armed && (progress < FIRE_EXIT_PROGRESS || (now - session.startTime) >= LOCK_ARM_DELAY_MS)) {
      session.armed = true;
    }
    if (!session.armed) return { closure: 0.0, fire: false };

    if (session.firePhase ? progress < FIRE_EXIT_PROGRESS : progress >= FIRE_ENTER_PROGRESS) {
      session.firePhase = !session.firePhase;
      LogDebug("lock phase " + (session.firePhase ? "FIRE" : "LOCK") + " at progress " + progress.toFixed(3));
    }
    return { closure: Math.max(0.0, Math.min(1.0, progress)), fire: session.firePhase };
  }

  function DrawScopeOverlay(scopeImg, lockState, now) {
    var chevrons = GetOrCreateChevronPanels(scopeImg);
    var statusText = GetOrCreateStatusPanels(scopeImg);
    var MAX_PIXEL_OFFSET = 180;
    var currentOffset = (MAX_PIXEL_OFFSET * (1.0 - lockState.closure)).toFixed(1);

    scopeImg.style.backgroundImage = "url('s2r://panorama/images/hud/crosshair/Crosshair_psd.vtex')";
    scopeImg.style.washColor = "#00FF66";
    scopeImg.style.imgShadow = g_cachedCrtShadow;

    chevrons.left.style.washColor = "#00FF66";
    chevrons.right.style.washColor = "#00FF66";
    chevrons.left.style.imgShadow = g_cachedCrtShadow;
    chevrons.right.style.imgShadow = g_cachedCrtShadow;
    chevrons.left.style.opacity = "1.0";
    chevrons.right.style.opacity = "1.0";
    chevrons.left.style.transform = "translateX(-" + currentOffset + "px)";
    chevrons.right.style.transform = "translateX(" + currentOffset + "px)";

    if (lockState.fire) {
      statusText.fire.style.washColor = "#00FF66";
      statusText.fire.style.imgShadow = g_cachedCrtShadow;
      statusText.fire.style.opacity = (now % 250) < 125 ? "1.0" : "0.0";
      statusText.lock.style.opacity = "0.0";
    } else {
      statusText.lock.style.washColor = "#00FF66";
      statusText.lock.style.imgShadow = g_cachedCrtShadow;
      statusText.lock.style.opacity = (now % 350) < 175 ? "1.0" : "0.0";
      statusText.fire.style.opacity = "0.0";
    }
  }

  function DrawCompass(root) {
    var compass = GetOrCreateCompassPanel(root);

    var currentYaw = GetMinimapYaw(root) + 90.0;
    if (currentYaw > 180) currentYaw -= 360;
    if (currentYaw < -180) currentYaw += 360;

    var TOTAL_DEGREES = 720;
    var IMAGE_WIDTH_PX = 4872;
    var PX_PER_DEGREE = IMAGE_WIDTH_PX / TOTAL_DEGREES;
    var compassOffsetPx = currentYaw * PX_PER_DEGREE;

    var panelWidth = compass.actuallayoutwidth;
    if (!panelWidth || panelWidth <= 0) panelWidth = 1075;

    var centerBaseX = (panelWidth / 2.0) - (IMAGE_WIDTH_PX / 2.0);
    var finalBgX = centerBaseX - compassOffsetPx;

    compass.style.washColor = "#00FF66";
    compass.visible = true;
    compass.style.visibility = "visible";
    compass.style.opacity = "1.0";
    compass.style.backgroundPosition = finalBgX.toFixed(1) + "px 0px";
  }

  function DrawLadders(root, now) {
    var ladders = GetOrCreateLadderPanels(root);
    var timeSec = now / 1000.0;
    var driftY = ((Math.sin(timeSec * 0.7) * 70) + (Math.cos(timeSec * 0.35) * 50)).toFixed(1);

    ladders.left.style.washColor = "#00FF66";
    ladders.right.style.washColor = "#00FF66";
    ladders.left.style.imgShadow = g_cachedCrtShadow;
    ladders.right.style.imgShadow = g_cachedCrtShadow;
    ladders.left.visible = true;
    ladders.right.visible = true;
    ladders.left.style.visibility = "visible";
    ladders.right.style.visibility = "visible";
    ladders.left.style.opacity = "1.0";
    ladders.right.style.opacity = "1.0";
    ladders.left.style.transform = "translateX(-30%) translateY(" + driftY + "px)";
    ladders.right.style.transform = "translateX(30%) translateY(" + driftY + "px)";
  }

  function UpdateAltimeter(root, now) {
    g_altimeterDisplay.GetOrCreate(root);
    var flightRatio = ReadFlightDurationProgress(FindFlightDurationLabel(root, now));
    // A cancelled flight can leave the timer frozen mid-way, so only a moving timer counts as flying.
    if (flightRatio !== g_flightLastRatio) {
      if (g_flightLastRatio !== null && flightRatio !== null) g_flightLastChangeTime = now;
      g_flightLastRatio = flightRatio;
    }
    var isAdvancing = g_flightLastChangeTime > 0 && (now - g_flightLastChangeTime) < FLIGHT_STALE_MS;
    var isFlying = isAdvancing && flightRatio !== null && flightRatio > 0.0 && flightRatio < 1.0;
    g_altimeterDisplay.Update(isFlying ? Math.floor((1.0 - flightRatio) * 9999) : 0, g_cachedCrtShadow);
    return { ratio: flightRatio, flying: isFlying };
  }

  function OwnerTick(root, panels, now) {
    g_stage = "scope-state";
    var slotActive = IsSnipeAbilityActive(root);
    if (slotActive) g_session.lastActiveTime = now;
    var scopeActive = slotActive || (g_session.active && (now - g_session.lastActiveTime) < SCOPE_END_GRACE_MS);
    if (scopeActive && !g_session.active) BeginScopeSession(now);
    if (!scopeActive && g_session.active) EndScopeSession();

    UpdateCrtShadow(now);

    g_stage = "charges";
    UpdateSnipeChargeIndicators(root, g_session.active);
    if (!g_session.active) return IDLE_INTERVAL;

    g_stage = "scope_img";
    var scopeImg = GetScopeImg(root);
    if (!IsValidPanel(scopeImg)) {
      HideOverlay();
      StopAllSounds();
      return IDLE_INTERVAL;
    }

    g_stage = "lock";
    var progress = IsValidPanel(panels.progress) ? ReadProgressValue(panels.progress) : null;
    var lockState = UpdateLockState(progress, now);

    g_stage = "overlay";
    DrawScopeOverlay(scopeImg, lockState, now);

    g_stage = "compass";
    DrawCompass(root);

    g_stage = "ladders";
    DrawLadders(root, now);

    g_stage = "altimeter";
    var flight = UpdateAltimeter(root, now);

    g_stage = "sounds";
    SetChannel(g_scopeChannel,
               lockState.fire ? SCOPE_FIRE_SOUND : SCOPE_LOCK_SOUND,
               lockState.fire ? FIRE_BEEP_INTERVAL : SCOPE_BEEP_INTERVAL);
    ServiceChannel(g_scopeChannel, now);
    ServiceChannel(g_warningChannel, now);

    if (DEBUG && (now - g_lastDebugLogTime) >= DEBUG_LOG_INTERVAL * 1000) {
      g_lastDebugLogTime = now;
      LogDebug("session=" + g_session.id +
               " progress=" + (progress === null ? "none" : progress.toFixed(3)) +
               " fire=" + lockState.fire +
               " flight=" + (flight.ratio === null ? "none" : flight.ratio.toFixed(3)) +
               " flying=" + flight.flying +
               " leaping=" + HasPanelClass(g_flightElement, "leaping"));
    }
    return ACTIVE_INTERVAL;
  }

  function Tick(now) {
    g_stage = "hud-root";
    var root = GetHudRoot();
    if (!root) {
      StandDown();
      return IDLE_INTERVAL;
    }

    g_stage = "identity";
    var strength = GetElementStrength();
    var panels = GetLocalProgressPanels();
    if (strength > 0) {
      HideNativeProgress(panels.progress, panels.backer);
    } else {
      RestoreNativeProgress(panels.progress, panels.backer);
    }

    g_stage = "ownership";
    var isOwner = strength > 0 && ClaimOwnership(root, strength, now);
    if (DEBUG) {
      var state = "strength=" + strength + " owner=" + isOwner;
      if (state !== g_lastDebugState) {
        g_lastDebugState = state;
        LogDebug(state + " element=" + g_progressElement.id + " classes=" + DescribeElementClasses());
      }
    }
    if (!isOwner) {
      StandDown();
      return IDLE_INTERVAL;
    }
    if (!g_isOwner) {
      g_isOwner = true;
      LogDebug("took HUD ownership");
      AdoptExistingOverlay(root);
    }
    return OwnerTick(root, panels, now);
  }

  function RecoverFromException() {
    StopAllSounds();
    try {
      if (g_isOwner) HideOverlay();
    } catch (e) {}
    g_isOwner = false;
    g_session.active = false;
    g_session.firePhase = false;
    DropPanelCaches();
  }

  function Shutdown() {
    if (g_isShutDown) return;
    g_isShutDown = true;
    if (g_schedulerId !== null) {
      try { $.CancelScheduled(g_schedulerId); } catch (e) {}
      g_schedulerId = null;
    }
    StopAllSounds();
    try {
      if (g_isOwner) HideOverlay();
    } catch (e) {}
    ReleaseOwnership();
    g_session.active = false;
    DropPanelCaches();
    LogDebug("shut down");
  }

  function SyncLoop() {
    g_schedulerId = null;
    if (g_isShutDown) return;
    // A deleted element never comes back, so this copy stops instead of running on as an orphan.
    if (!IsValidPanel(g_progressElement)) {
      Shutdown();
      return;
    }

    var nextInterval = IDLE_INTERVAL;
    try {
      nextInterval = Tick(Date.now());
    } catch (e) {
      ReportException(e);
      RecoverFromException();
    }

    try {
      g_schedulerId = $.Schedule(nextInterval, SyncLoop);
    } catch (e) {
      Shutdown();
    }
  }

  if (typeof $ !== "undefined" && $.RegisterForUnload) {
    $.RegisterForUnload(Shutdown);
  }

  SyncLoop();
})();