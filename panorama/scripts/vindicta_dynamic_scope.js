(function () {
  "use strict";

  var ACTIVE_INTERVAL = 0.016;
  var IDLE_INTERVAL = 0.15;
  var HERO_RECHECK_INTERVAL = 2.0;
  var DEBUG_LOG_INTERVAL = 1.0;
  var VINDICTA_HERO_NAME = "hornet";
  var DEBUG = true;

  var g_schedulerId = null;
  var g_hudRoot = null;
  var g_chevronLeft = null;
  var g_chevronRight = null;
  var g_meleeAbilityPanel = null;
  var g_cachedHeroName = null;
  var g_lastHeroRecheckTime = 0;
  var g_lastDebugLogTime = 0;

  var g_progressElement = $.GetContextPanel();
  var g_circularProgress = null;
  var g_circularProgressBacker = null;

  var g_scopeImg = null;

  var g_lastOpacity = -1.0;
  var g_lastAimingState = false;
  var g_isNativeHidden = false;
  var g_isMaskHidden = false;

  // Flickering and glow variables
  var g_prevRawProgress = 0.0;
  var g_lastFlickerTime = 0;
  var g_cachedCrtShadow = "0px 0px 7.0px 1.0 #39FF14FF";

  // Lock and fire flashing variables
  var g_statusLock = null;
  var g_statusFire = null;

  // Compass variables
  var g_compassViewport = null;
  var g_compassPanel = null;
  var g_minimapMainImage = null;

  // Left and right ladders
  var g_ladderLeft = null;
  var g_ladderRight = null;

  var SNIPE_BASE_MAX_CHARGES = 2;
  var SNIPE_CHARGE_ICON_WIDTH = 42;
  var SNIPE_CHARGE_ICON_HEIGHT = 32;
  var SNIPE_CHARGE_ICON_GAP = 5;
  var SNIPE_AVAILABLE_TEXTURE = "s2r://panorama/images/hud/crosshair/arm_psd.vtex";
  var SNIPE_SPENT_TEXTURE = "s2r://panorama/images/hud/crosshair/armspent_psd.vtex";
  var g_snipeChargePanel = null;
  var g_snipeChargeIcons = [];
  var g_snipeChargeTextures = [];
  var g_snipeMaxObserved = SNIPE_BASE_MAX_CHARGES;
  var g_snipeCurrentObserved = SNIPE_BASE_MAX_CHARGES;
  var g_snipeHasObservedCurrent = false;
  var g_lastSnipeChargeStatus = null;
  var g_snipeAbilityPanel = null;
  var g_snipeAbilityNameDiagnostic = "unknown";
  var g_lastSnipeAbilitySearchTime = 0;
  var g_snipeChargeSearchDiagnostic = "";

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
    var names = ["max_charges", "maxCharges", "charges_max", "max_charge_count", "AbilityCharges", "ability_charges"];
    var maximum = null;

    var dividerContainer = panel.FindChildTraverse("stack_divider_container");
    if (IsValidPanel(dividerContainer)) {
      var dividerCount = 0;
      var dividerChildren = dividerContainer.Children ? dividerContainer.Children() : [];
      for (var d = 0; d < dividerChildren.length; d++) {
        try {
          if (dividerChildren[d].BHasClass && dividerChildren[d].BHasClass("stack_divider")) dividerCount++;
        } catch (e) {}
      }
      if (dividerCount > 0) maximum = dividerCount + 1;
    }

    var pending = [{ panel: panel, depth: 0 }];

    while (pending.length > 0) {
      var entry = pending.pop();
      if (!IsValidPanel(entry.panel) || entry.depth > 8) continue;

      for (var i = 0; i < names.length; i++) {
        var value = ReadIntegerAttribute(entry.panel, names[i]);
        if (value !== null && value > 0 && (maximum === null || value > maximum)) {
          maximum = value;
        }
      }

      var children = entry.panel.Children ? entry.panel.Children() : [];
      for (var c = 0; c < children.length; c++) {
        pending.push({ panel: children[c], depth: entry.depth + 1 });
      }
    }

    return maximum;
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

  function LogSnipeChargeStatus(status) {
    if (status === g_lastSnipeChargeStatus) return;
    g_lastSnipeChargeStatus = status;
    $.Msg("[VindictaSnipeCharges] " + status);
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

  function GetOrCreateSnipeChargePanel(root) {
    if (IsValidPanel(g_snipeChargePanel)) return g_snipeChargePanel;

    var existing = root.FindChildTraverse("VindictaSnipeChargeStack");
    if (IsValidPanel(existing)) {
      g_snipeChargePanel = existing;
      g_snipeChargeIcons = [];
      g_snipeChargeTextures = [];
      for (var i = 0; ; i++) {
        var icon = existing.FindChildTraverse("VindictaSnipeCharge_" + i);
        if (!IsValidPanel(icon)) break;
        g_snipeChargeIcons.push(icon);
        g_snipeChargeTextures.push(null);
      }
      return g_snipeChargePanel;
    }

    var panel = $.CreatePanel("Panel", root, "VindictaSnipeChargeStack");
    panel.style.horizontalAlign = "center";
    panel.style.verticalAlign = "center";
    panel.style.marginLeft = "-30%";
    panel.style.marginTop = "0%";
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
    g_snipeChargeIcons = [];
    g_snipeChargeTextures = [];
    return g_snipeChargePanel;
  }

  function UpdateSnipeChargeIndicators(root, isAiming) {
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

    while (g_snipeChargeIcons.length < maximumCharges) {
      var iconIndex = g_snipeChargeIcons.length;
      var icon = $.CreatePanel("Panel", panel, "VindictaSnipeCharge_" + iconIndex);
      g_snipeChargeIcons.push(icon);
      g_snipeChargeTextures.push(null);
    }
    while (g_snipeChargeIcons.length > maximumCharges) {
      var removedIcon = g_snipeChargeIcons.pop();
      g_snipeChargeTextures.pop();
      if (IsValidPanel(removedIcon)) removedIcon.DeleteAsync(0);
    }

    panel.style.width = SNIPE_CHARGE_ICON_WIDTH + "px";
    panel.style.height = (maximumCharges * (SNIPE_CHARGE_ICON_HEIGHT + SNIPE_CHARGE_ICON_GAP)) + "px";
    panel.style.horizontalAlign = "center";
    panel.style.verticalAlign = "center";
    panel.style.marginLeft = "-30%";
    panel.style.marginTop = "-10%";
    panel.style.transform = "translateY(20px)";
    panel.style.flowChildren = "down";
    panel.style.zIndex = "1000";
    panel.style.visibility = "visible";
    panel.style.opacity = isAiming ? "1.0" : "0.0";
    for (var i = 0; i < g_snipeChargeIcons.length; i++) {
      var chargeIcon = g_snipeChargeIcons[i];
      chargeIcon.style.width = SNIPE_CHARGE_ICON_WIDTH + "px";
      chargeIcon.style.height = SNIPE_CHARGE_ICON_HEIGHT + "px";
      chargeIcon.style.marginBottom = SNIPE_CHARGE_ICON_GAP + "px";
      chargeIcon.style.backgroundImage = null;
      chargeIcon.style.visibility = "visible";
      chargeIcon.style.opacity = isAiming ? "1.0" : "0.0";

      var chargeImage = chargeIcon.FindChildTraverse("VindictaSnipeChargeImage_" + i);
      if (!IsValidPanel(chargeImage)) {
        chargeImage = $.CreatePanel("Image", chargeIcon, "VindictaSnipeChargeImage_" + i);
      }
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
      try {
        if (chargeImage.SetScaling) chargeImage.SetScaling("stretch-to-fit-preserve-aspect");
      } catch (e) {}
    }
    LogSnipeChargeStatus("source=" + chargeSource + " current=" + currentCharges + " max=" + maximumCharges +
                         " currentSource=" + currentChargeSource +
               " panel=" + (IsValidPanel(abilityPanel) ? abilityPanel.id : "missing") +
               " scope=" + (isAiming ? "active" : "inactive"));
  }

  function HideSnipeChargeIndicators() {
    if (IsValidPanel(g_snipeChargePanel)) g_snipeChargePanel.style.opacity = "0.0";
  }

  function ExtractHeroFromId(id) {
    if (typeof id !== "string") return null;
    if (id.indexOf("citadel_ability_melee_") === 0) {
      var partsLong = id.split("_");
      if (partsLong.length >= 5 && partsLong[4] === "melee") return partsLong[3];
    } else if (id.indexOf("ability_melee_") === 0) {
      var partsShort = id.split("_");
      if (partsShort.length >= 4 && partsShort[3] === "melee") return partsShort[2];
    }
    return null;
  }

  function FindMeleeAbilityPanel(root) {
    var found = null;
    function Search(panel, depth) {
      if (found || !panel || depth > 20) return;
      var id = "";
      try { id = panel.id || ""; } catch (e) {}

      if (ExtractHeroFromId(id)) {
        found = panel;
        return;
      }
      var kids = panel.Children ? panel.Children() : [];
      for (var i = 0; i < kids.length; i++) {
        Search(kids[i], depth + 1);
        if (found) return;
      }
    }
    Search(root, 0);
    return found;
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

  function ReadFlightDurationProgress(root) {
    try {
      // Target the exact panel from the log dump
      var clippedLabel = root.FindChildTraverse("ability_name_clipped");
      
      if (IsValidPanel(clippedLabel) && clippedLabel.style && clippedLabel.style.clip) {
        var clipStr = clippedLabel.style.clip;
        
        // Example clip string: rect( 0.0%, 19.403957%, 100.0%, 0.0%)
        // This regex extracts all numbers followed by a % symbol
        var matches = clipStr.match(/(\d+(?:\.\d+)?)%/g);
        
        if (matches && matches.length >= 2) {
          // The second percentage is the 'right' clip bound dictating the bar width
          var widthPercent = parseFloat(matches[1]);
          if (!isNaN(widthPercent)) {
            // Convert 0-100% to a 0.0 - 1.0 ratio
            return widthPercent / 100.0;
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
      this.warningMode = null;
      this.warningStartTime = 0;
    },

    Destroy: function () {
      if (IsValidPanel(this.container)) {
        this.container.DeleteAsync(0);
      }
      this.container = null;
      this.boxImage = null;
      this.altImage = null;
      this.pullUpImage = null;
      this.strips = [];
      this.warningMode = null;
      this.warningStartTime = 0;
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

  function GetOrCreateLadderPanels(root) {
    if (IsValidPanel(g_ladderLeft) && IsValidPanel(g_ladderRight)) {
      return { left: g_ladderLeft, right: g_ladderRight };
    }

    var existingLeft = root.FindChildTraverse("VindictaLadderLeft");
    var existingRight = root.FindChildTraverse("VindictaLadderRight");
    
    if (existingLeft && existingRight) {
      g_ladderLeft = existingLeft;
      g_ladderRight = existingRight;
      return { left: g_ladderLeft, right: g_ladderRight };
    }

    var leftPanel = $.CreatePanel("Image", root, "VindictaLadderLeft");
    leftPanel.SetImage("s2r://panorama/images/hud/crosshair/ladder_psd.vtex");
    leftPanel.style.horizontalAlign = "center";
    leftPanel.style.verticalAlign = "center";
    leftPanel.style.transform = "translateX(-30%)";
    leftPanel.style.width = "76px";
    leftPanel.style.height = "1344px";
    leftPanel.style.opacity = "0.0";
    leftPanel.style.overflow = "noclip";

    var rightPanel = $.CreatePanel("Image", root, "VindictaLadderRight");
    rightPanel.SetImage("s2r://panorama/images/hud/crosshair/ladder_psd.vtex");
    rightPanel.style.horizontalAlign = "center";
    rightPanel.style.verticalAlign = "center";
    rightPanel.style.transform = "translateX(30%)";
    rightPanel.style.width = "76px";
    rightPanel.style.height = "1344px";
    rightPanel.style.opacity = "0.0";
    rightPanel.style.overflow = "noclip";

    g_ladderLeft = leftPanel;
    g_ladderRight = rightPanel;
    return { left: g_ladderLeft, right: g_ladderRight };
  }

  function ForceRedetectHero(root) {
    var panel = FindMeleeAbilityPanel(root);
    g_meleeAbilityPanel = panel;
    g_cachedHeroName = panel ? ExtractHeroFromId(panel.id || "") : null;
    return g_cachedHeroName;
  }

  function DetectCurrentHero(root) {
    var now = Date.now() / 1000.0;
    var dueForRecheck = (now - g_lastHeroRecheckTime) >= HERO_RECHECK_INTERVAL;
    if (dueForRecheck) {
      g_lastHeroRecheckTime = now;
      return ForceRedetectHero(root);
    }
    if (IsValidPanel(g_meleeAbilityPanel)) {
      var hero = ExtractHeroFromId(g_meleeAbilityPanel.id || "");
      if (hero) return hero;
    }
    return ForceRedetectHero(root);
  }

  function GetLocalProgressPanels() {
    if (IsValidPanel(g_circularProgress)) return { progress: g_circularProgress, backer: g_circularProgressBacker };
    if (IsValidPanel(g_progressElement)) {
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

  function ReadProgressValue(localProgress) {
    if (localProgress.value !== undefined) return { value: localProgress.value, source: "value" };
    if (localProgress.progress !== undefined) return { value: localProgress.progress, source: "progress" };
    if (localProgress.style && localProgress.style.clip) {
      var matches = localProgress.style.clip.match(/(\d+(\.\d+)?)deg/g);
      if (matches && matches.length > 0) {
        var endAngleDeg = parseFloat(matches[matches.length - 1]);
        return { value: endAngleDeg / 360.0, source: "clip:" + localProgress.style.clip };
      }
    }
    return { value: 0.0, source: "fallback-zero" };
  }

  function GetOrCreateChevronPanels(scopeImg) {
    if (IsValidPanel(g_chevronLeft) && IsValidPanel(g_chevronRight)) {
      return { left: g_chevronLeft, right: g_chevronRight };
    }
    var existingLeft = scopeImg.FindChildTraverse("VindictaChevronLeft");
    var existingRight = scopeImg.FindChildTraverse("VindictaChevronRight");
    if (existingLeft && existingRight) {
      g_chevronLeft = existingLeft;
      g_chevronRight = existingRight;
      return { left: g_chevronLeft, right: g_chevronRight };
    }

    var left = $.CreatePanel("Image", scopeImg, "VindictaChevronLeft");
    left.SetImage("s2r://panorama/images/hud/crosshair/chevron_left_psd.vtex");
    left.style.horizontalAlign = "center";
    left.style.verticalAlign = "center";
    left.style.width = "128px";
    left.style.height = "128px";
    left.style.opacity = "0.0";

    var right = $.CreatePanel("Image", scopeImg, "VindictaChevronRight");
    right.SetImage("s2r://panorama/images/hud/crosshair/chevron_right_psd.vtex");
    right.style.horizontalAlign = "center";
    right.style.verticalAlign = "center";
    right.style.width = "128px";
    right.style.height = "128px";
    right.style.opacity = "0.0";

    g_chevronLeft = left;
    g_chevronRight = right;
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
    if (IsValidPanel(g_statusLock) && IsValidPanel(g_statusFire)) {
      return { lock: g_statusLock, fire: g_statusFire };
    }

    var existingLock = scopeImg.FindChildTraverse("VindictaStatusLock");
    var existingFire = scopeImg.FindChildTraverse("VindictaStatusFire");
    if (existingLock && existingFire) {
      g_statusLock = existingLock;
      g_statusFire = existingFire;
      return { lock: g_statusLock, fire: g_statusFire };
    }

    var lockPanel = $.CreatePanel("Image", scopeImg, "VindictaStatusLock");
    lockPanel.SetImage("s2r://panorama/images/hud/crosshair/lock_psd.vtex");
    lockPanel.style.horizontalAlign = "center";
    lockPanel.style.verticalAlign = "center";
    lockPanel.style.transform = "translateY(50px)";
    lockPanel.style.width = "64px";
    lockPanel.style.height = "32px";
    lockPanel.style.opacity = "0.0";

    var firePanel = $.CreatePanel("Image", scopeImg, "VindictaStatusFire");
    firePanel.SetImage("s2r://panorama/images/hud/crosshair/fire_psd.vtex");
    firePanel.style.horizontalAlign = "center";
    firePanel.style.verticalAlign = "center";
    firePanel.style.transform = "translateY(50px)";
    firePanel.style.width = "64px";
    firePanel.style.height = "32px";
    firePanel.style.opacity = "0.0";

    g_statusLock = lockPanel;
    g_statusFire = firePanel;
    return { lock: g_statusLock, fire: g_statusFire };
  }

  function MaybeLogDebug(hero, progressInfo, scopeImgFound, localProgressFound, root) {
    if (!DEBUG) return;
    var now = Date.now() / 1000.0;
    if ((now - g_lastDebugLogTime) < DEBUG_LOG_INTERVAL) return;
    g_lastDebugLogTime = now;
    $.Msg(
      "[VindictaMask] root=" + (root ? "found" : "NULL") +
      " hero=" + (hero || "NULL") +
      " local_progress=" + (localProgressFound ? "found" : "NULL") +
      " scope_img=" + (scopeImgFound ? "found" : "NULL") +
      " progress=" + (progressInfo ? progressInfo.value.toFixed(3) : "N/A")
    );
  }

  function SyncLoop() {
    var nextInterval = IDLE_INTERVAL;
    try {
      if (IsValidPanel(g_progressElement)) {
        var root = GetHudRoot();
        if (root) {
          var hero = DetectCurrentHero(root);
          if (hero === VINDICTA_HERO_NAME) {
            var panels = GetLocalProgressPanels();
            if (panels.progress) {
              var progressInfo = ReadProgressValue(panels.progress);
              
              var rawVal = progressInfo.value;
              var nextOpacity = (typeof rawVal === "number" && !isNaN(rawVal)) ? rawVal : 0.0;
              var isAiming = nextOpacity > 0.0;

              try {
                if (g_progressElement && (g_progressElement.style.visibility === "collapse" || g_progressElement.BHasClass("Hidden") || g_progressElement.actualvisibility === "collapse" || g_progressElement.visible === false)) {
                  isAiming = false;
                }
                var tempScope = GetScopeImg(root);
                if (tempScope && (tempScope.style.visibility === "collapse" || tempScope.BHasClass("Hidden") || tempScope.actualvisibility === "collapse" || tempScope.visible === false)) {
                  isAiming = false;
                }
              } catch (e) {}

              if (isAiming && nextOpacity > 0.0 && nextOpacity < 1.0) {
                if (nextOpacity === g_prevRawProgress) {
                  SyncLoop.stuckFrames = (SyncLoop.stuckFrames || 0) + 1;
                  if (SyncLoop.stuckFrames > 6) {
                    isAiming = false;
                  }
                } else {
                  SyncLoop.stuckFrames = 0;
                }
              } else {
                SyncLoop.stuckFrames = 0;
              }

              if (!isAiming) {
                var rogueCompass = root.FindChildTraverse("VindictaCompassTape");
                if (rogueCompass) {
                  rogueCompass.DeleteAsync(0);
                }
                if (typeof g_compassPanel !== 'undefined' && g_compassPanel !== null) {
                  g_compassPanel = null;
                }
              }

              HideNativeProgress(panels.progress, panels.backer);

              var scopeImg = GetScopeImg(root);
              UpdateSnipeChargeIndicators(root, isAiming && IsValidPanel(scopeImg));
              if (scopeImg) {
                var chevrons = GetOrCreateChevronPanels(scopeImg);
                var statusText = GetOrCreateStatusPanels(scopeImg);
                var ladders = GetOrCreateLadderPanels(root);
                
                var isClimbing = nextOpacity >= g_prevRawProgress;
                g_prevRawProgress = nextOpacity;

                if (isAiming) nextInterval = ACTIVE_INTERVAL;

                var now = Date.now();
                if (!g_lastFlickerTime || (now - g_lastFlickerTime) > 30) {
                  g_lastFlickerTime = now;
                  var baseBlur = 7.0;
                  var blurJitter = (Math.random() * 1.6) - 0.8;
                  var currentBlur = (baseBlur + blurJitter).toFixed(1);
                  var flickerAlpha = (Math.random() > 0.88) ? "E6" : "FF"; 
                  g_cachedCrtShadow = "0px 0px " + currentBlur + "px 1.0 #39FF14" + flickerAlpha;
                }

                var progressChanged = Math.abs(g_lastOpacity - nextOpacity) > 0.002;
                if (progressChanged || g_lastAimingState !== isAiming || isAiming) {
                  var MAX_PIXEL_OFFSET = 180;
                  
                  var normalizedProgress = isClimbing ? (1.0 - nextOpacity) : nextOpacity;
                  var currentOffset = MAX_PIXEL_OFFSET * normalizedProgress;

                  if (isAiming) {
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

                    var centerBaseX = (panelWidth / 2.0) - (4872.0 / 2.0);
                    var finalBgX = centerBaseX - compassOffsetPx;

                    compass.style.washColor = "#00FF66";
                    compass.visible = true;
                    compass.style.visibility = "visible";
                    compass.style.opacity = "1.0";
                    
                    compass.style.backgroundPosition = finalBgX.toFixed(1) + "px 0px";

                    scopeImg.style.backgroundImage = "url('s2r://panorama/images/hud/crosshair/Crosshair_psd.vtex')";
                    scopeImg.style.washColor = "#00FF66";
                    scopeImg.style.imgShadow = g_cachedCrtShadow;

                    chevrons.left.style.washColor = "#00FF66";
                    chevrons.right.style.washColor = "#00FF66";
                    chevrons.left.style.imgShadow = g_cachedCrtShadow;
                    chevrons.right.style.imgShadow = g_cachedCrtShadow;
                    chevrons.left.style.opacity = "1.0";
                    chevrons.right.style.opacity = "1.0";
                    chevrons.left.style.transform = "translateX(" + (-currentOffset) + "px)";
                    chevrons.right.style.transform = "translateX(" + currentOffset + "px)";

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

                    var timeSec = now / 1000.0;
                    var driftY = (Math.sin(timeSec * 0.7) * 70) + (Math.cos(timeSec * 0.35) * 50);
                    
                    ladders.left.style.transform = "translateX(-30%) translateY(" + driftY.toFixed(1) + "px)";
                    ladders.right.style.transform = "translateX(30%) translateY(" + driftY.toFixed(1) + "px)";

                    var isFullyLocked = normalizedProgress <= 0.05;
                    
                    if (!isFullyLocked) {
                      var lockFlashOn = (now % 350) < 175;
                      statusText.lock.style.washColor = "#00FF66";
                      statusText.lock.style.imgShadow = g_cachedCrtShadow;
                      statusText.lock.style.opacity = lockFlashOn ? "1.0" : "0.0";
                      statusText.fire.style.opacity = "0.0";
                    } else {
                      var fireFlashOn = (now % 250) < 125;
                      statusText.fire.style.washColor = "#00FF66";
                      statusText.fire.style.imgShadow = g_cachedCrtShadow;
                      statusText.fire.style.opacity = fireFlashOn ? "1.0" : "0.0";
                      statusText.lock.style.opacity = "0.0";
                    }

                    // --- DYNAMIC FLIGHT DURATION READOUT (9999 -> 0000) ---
                    g_altimeterDisplay.GetOrCreate(root);

                    var cancelPrompt = root.FindChildTraverse("citadel_ability_hornet_leap_cancel_single_ability");
                    var isFlying = false;
                    if (IsValidPanel(cancelPrompt)) {
                      var isHidden = cancelPrompt.BHasClass("Hidden") ||
                                     cancelPrompt.style.visibility === "collapse" ||
                                     cancelPrompt.visible === false;
                      isFlying = !isHidden;
                    }

                    var flightValue = 0;

                    if (isFlying) {
                      var progressRatio = ReadFlightDurationProgress(root);
                      
                      if (progressRatio !== null) {
                        // Invert the ratio (1.0 - progressRatio) so it counts DOWN instead of UP
                        var remainingRatio = 1.0 - progressRatio;
                        flightValue = Math.floor(Math.max(0.0, Math.min(1.0, remainingRatio)) * 9999);
                      } else {
                        flightValue = 9999;
                      }
                    } else {
                      flightValue = 0;
                    }

                    g_altimeterDisplay.Update(flightValue, g_cachedCrtShadow);

                  } else {
                    if (IsValidPanel(g_compassPanel)) {
                      g_compassPanel.DeleteAsync(0);
                      g_compassPanel = null;
                    }

                    g_altimeterDisplay.Hide();
                    
                    scopeImg.style.backgroundImage = null;
                    scopeImg.style.washColor = null;
                    scopeImg.style.imgShadow = null;
                    chevrons.left.style.opacity = "0.0";
                    chevrons.right.style.opacity = "0.0";
                    if (IsValidPanel(g_statusLock)) g_statusLock.style.opacity = "0.0";
                    if (IsValidPanel(g_statusFire)) g_statusFire.style.opacity = "0.0";
                    if (IsValidPanel(g_ladderLeft)) g_ladderLeft.style.opacity = "0.0";
                    if (IsValidPanel(g_ladderRight)) g_ladderRight.style.opacity = "0.0";
                  }

                  g_lastOpacity = nextOpacity;
                  g_lastAimingState = isAiming;
                  g_isMaskHidden = !isAiming;
                }
              }

              //MaybeLogDebug(hero, progressInfo, !!scopeImg, true, root);
            } else {
              HideSnipeChargeIndicators();
              //MaybeLogDebug(hero, { value: 0, source: "no-progress" }, false, false, root);
            }
          } else {
            LogSnipeChargeStatus("Vindicta hero not detected: " + (hero || "none"));
            HideSnipeChargeIndicators();
            if (IsValidPanel(g_scopeImg)) {
              g_scopeImg.style.backgroundImage = null;
              g_scopeImg.style.washColor = null;
              g_scopeImg.style.imgShadow = null;
            }
            
            g_altimeterDisplay.Destroy();

            var strayCompass = root.FindChildTraverse("VindictaCompassTape");
            if (strayCompass) {
              strayCompass.DeleteAsync(0);
            }
            if (IsValidPanel(g_compassPanel)) {
              g_compassPanel.DeleteAsync(0);
              g_compassPanel = null;
            }
            
            if (!g_isMaskHidden) {
              if (IsValidPanel(g_chevronLeft)) g_chevronLeft.style.opacity = "0.0";
              if (IsValidPanel(g_chevronRight)) g_chevronRight.style.opacity = "0.0";
              if (IsValidPanel(g_statusLock)) g_statusLock.style.opacity = "0.0";
              if (IsValidPanel(g_statusFire)) g_statusFire.style.opacity = "0.0";
              if (IsValidPanel(g_ladderLeft)) g_ladderLeft.style.opacity = "0.0";
              if (IsValidPanel(g_ladderRight)) g_ladderRight.style.opacity = "0.0";
              
              g_isMaskHidden = true;
              g_lastOpacity = 0.0;
              g_lastAimingState = false;
            }
            var localPanels = GetLocalProgressPanels();
            if (localPanels.progress) {
              RestoreNativeProgress(localPanels.progress, localPanels.backer);
            }
          }
        }
      }
    } catch (e) {
      $.Msg("[VindictaMask] EXCEPTION: " + e);
    }
    g_schedulerId = $.Schedule(nextInterval, SyncLoop);
  }

  function Cleanup() {
    if (g_schedulerId) {
      $.CancelScheduled(g_schedulerId);
      g_schedulerId = null;
    }

    g_altimeterDisplay.Destroy();

    if (IsValidPanel(g_chevronLeft)) g_chevronLeft.DeleteAsync(0);
    if (IsValidPanel(g_chevronRight)) g_chevronRight.DeleteAsync(0);
    if (IsValidPanel(g_statusLock)) g_statusLock.DeleteAsync(0);
    if (IsValidPanel(g_statusFire)) g_statusFire.DeleteAsync(0);
    if (IsValidPanel(g_compassViewport)) g_compassViewport.DeleteAsync(0);
    if (IsValidPanel(g_compassPanel)) g_compassPanel.DeleteAsync(0);
    
    g_chevronLeft = null;
    g_chevronRight = null;
    g_statusLock = null;
    g_statusFire = null;
    g_compassViewport = null;
    g_compassPanel = null;
    g_hudRoot = null;
    g_meleeAbilityPanel = null;
    g_scopeImg = null;
    g_circularProgress = null;
    g_circularProgressBacker = null;
    g_progressElement = null;

    g_lastOpacity = -1.0;
    g_lastAimingState = false;
    g_isNativeHidden = false;
    g_isMaskHidden = false;
    g_prevRawProgress = 0.0;
  }

  if (typeof $ !== "undefined" && $.RegisterForUnload) {
    $.RegisterForUnload(Cleanup);
  }

  SyncLoop();
})();