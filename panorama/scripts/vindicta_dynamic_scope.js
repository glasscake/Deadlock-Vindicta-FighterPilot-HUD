(function () {
  "use strict";

  var ACTIVE_INTERVAL = 0.016;
  var IDLE_INTERVAL = 0.15;
  var HERO_RECHECK_INTERVAL = 2.0;
  var DEBUG_LOG_INTERVAL = 1.0;
  var VINDICTA_HERO_NAME = "hornet";
  var DEBUG = false;

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

  var g_prevRawProgress = 0.0;
  var g_isRechargePhase = false;

  function FindHudRoot() {
    var current = g_progressElement;
    while (current) {
      if (current.id === "CitadelHudRoot") return current;
      current = current.GetParent();
    }
    return null;
  }

  function GetHudRoot() {
    if (!g_hudRoot || !g_hudRoot.IsValid()) g_hudRoot = FindHudRoot();
    return g_hudRoot;
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
    if (g_meleeAbilityPanel && g_meleeAbilityPanel.IsValid && g_meleeAbilityPanel.IsValid()) {
      var hero = ExtractHeroFromId(g_meleeAbilityPanel.id || "");
      if (hero) return hero;
    }
    return ForceRedetectHero(root);
  }

  function IsValidPanel(p) {
    return p && p.IsValid && p.IsValid();
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
    if (localProgress.style.clip) {
      var matches = localProgress.style.clip.match(/(\d+(\.\d+)?)deg/g);
      if (matches && matches.length > 0) {
        var endAngleDeg = parseFloat(matches[matches.length - 1]);
        return { value: endAngleDeg / 360.0, source: "clip:" + localProgress.style.clip };
      }
    }
    return { value: 0.0, source: "fallback-zero" };
  }

  function HideNativeProgress(localProgress, localBacker) {
    if (g_isNativeHidden) return;
    var changed = false;
    if (localProgress && localProgress.style.visibility !== "collapse") {
      localProgress.style.visibility = "collapse";
      changed = true;
    }
    if (localBacker && localBacker.style.visibility !== "collapse") {
      localBacker.style.visibility = "collapse";
      changed = true;
    }
    if (changed) g_isNativeHidden = true;
  }

  function RestoreNativeProgress(localProgress, localBacker) {
    var changed = false;
    if (localProgress && localProgress.style.visibility === "collapse") {
      localProgress.style.visibility = null;
      changed = true;
    }
    if (localBacker && localBacker.style.visibility === "collapse") {
      localBacker.style.visibility = null;
      changed = true;
    }
    if (changed) g_isNativeHidden = false;
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
    left.style.washColor = "#00FF66";
    // Toned-down glow: 8px blur radius, 1.0 strength multiplier
    left.style.imgShadow = "0px 0px 8px 1.0 #39FF14";

    var right = $.CreatePanel("Image", scopeImg, "VindictaChevronRight");
    right.SetImage("s2r://panorama/images/hud/crosshair/chevron_right_psd.vtex");
    right.style.horizontalAlign = "center";
    right.style.verticalAlign = "center";
    right.style.width = "128px";
    right.style.height = "128px";
    right.style.opacity = "0.0";
    right.style.washColor = "#00FF66";
    right.style.imgShadow = "0px 0px 8px 1.0 #39FF14";

    g_chevronLeft = left;
    g_chevronRight = right;
    return { left: g_chevronLeft, right: g_chevronRight };
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
      " progress=" + progressInfo.value.toFixed(3) +
      " (source: " + progressInfo.source + ")"
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
              HideNativeProgress(panels.progress, panels.backer);

              var scopeImg = GetScopeImg(root);
              if (scopeImg) {
                var chevrons = GetOrCreateChevronPanels(scopeImg);
                
                // Sanitize progress value to prevent NaN math errors
                var rawVal = progressInfo.value;
                var nextOpacity = (typeof rawVal === "number" && !isNaN(rawVal)) ? rawVal : 0.0;

                // Detect if progress value is climbing (0 -> 1) or falling (1 -> 0)
                var isClimbing = nextOpacity >= g_prevRawProgress;
                g_prevRawProgress = nextOpacity;

                var isAiming = nextOpacity > 0.0;
                if (!isAiming) {
                  try {
                    var vis = scopeImg.style.visibility;
                    var actVis = scopeImg.actualvisibility;
                    if (vis !== "collapse" && actVis !== "collapse") {
                      isAiming = true;
                    }
                  } catch (e) {}
                }

                if (isAiming) nextInterval = ACTIVE_INTERVAL;

                // Generate CRT jitter values on every frame
                var baseBlur = 8;
                var blurJitter = (Math.random() * 3.0) - 1.5; // Jitter between -1.5px and +1.5px
                var currentBlur = (baseBlur + blurJitter).toFixed(1);

                // Subtle alpha flicker (10% - 15% opacity drop on occasional frames)
                var flickerAlpha = (Math.random() > 0.85) ? "CC" : "FF"; 
                var crtShadowStyle = "0px 0px " + currentBlur + "px 1.0 #39FF14" + flickerAlpha;

                // Force frame re-render for flickering even if progress is static
                var progressChanged = Math.abs(g_lastOpacity - nextOpacity) > 0.002;
                if (progressChanged || g_lastAimingState !== isAiming || isAiming) {
                  var MAX_PIXEL_OFFSET = 180;
                  
                  var normalizedProgress = isClimbing ? (1.0 - nextOpacity) : nextOpacity;
                  var currentOffset = MAX_PIXEL_OFFSET * normalizedProgress;

                  if (isAiming) {
                    scopeImg.style.backgroundImage = "url('s2r://panorama/images/hud/crosshair/Crosshair_psd.vtex')";
                    scopeImg.style.washColor = "#00FF66";
                    scopeImg.style.imgShadow = crtShadowStyle;

                    chevrons.left.style.washColor = "#00FF66";
                    chevrons.right.style.washColor = "#00FF66";
                    chevrons.left.style.imgShadow = crtShadowStyle;
                    chevrons.right.style.imgShadow = crtShadowStyle;

                    chevrons.left.style.opacity = "1.0";
                    chevrons.right.style.opacity = "1.0";
                    chevrons.left.style.transform = "translateX(" + (-currentOffset) + "px)";
                    chevrons.right.style.transform = "translateX(" + currentOffset + "px)";
                  } else {
                    scopeImg.style.backgroundImage = null;
                    scopeImg.style.washColor = null;
                    scopeImg.style.imgShadow = null;
                    chevrons.left.style.opacity = "0.0";
                    chevrons.right.style.opacity = "0.0";
                  }

                  g_lastOpacity = nextOpacity;
                  g_lastAimingState = isAiming;
                  g_isMaskHidden = !isAiming;
                }
              }

              MaybeLogDebug(hero, progressInfo, !!scopeImg, true, root);
            } else {
              MaybeLogDebug(hero, { value: 0, source: "no-progress" }, false, false, root);
            }
          } else {
            if (IsValidPanel(g_scopeImg)) {
              g_scopeImg.style.backgroundImage = null;
              g_scopeImg.style.washColor = null;
              g_scopeImg.style.imgShadow = null;
            }
            if (IsValidPanel(g_chevronLeft) && !g_isMaskHidden) {
              g_chevronLeft.style.opacity = "0.0";
              g_chevronRight.style.opacity = "0.0";
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
    if (IsValidPanel(g_chevronLeft)) g_chevronLeft.DeleteAsync(0);
    if (IsValidPanel(g_chevronRight)) g_chevronRight.DeleteAsync(0);
    
    g_chevronLeft = null;
    g_chevronRight = null;
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
  }

  if (typeof $ !== "undefined" && $.RegisterForUnload) {
    $.RegisterForUnload(Cleanup);
  }

  SyncLoop();
})();