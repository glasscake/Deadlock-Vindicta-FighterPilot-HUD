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

  // Flickering and glow variables
  var g_prevRawProgress = 0.0;
  var g_lastFlickerTime = 0;
  var g_cachedCrtShadow = "0px 0px 7.0px 1.0 #39FF14FF";

  // Lock and fire flashing variables
  var g_statusLock = null;
  var g_statusFire = null;
  var g_lastStatusFlashTime = 0;

  // Compass variables
  var g_compassPanel = null;
  var g_minimapMainImage = null;

  //lleft and right ladders
  var g_ladderLeft = null;
  var g_ladderRight = null;

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

function GetOrCreateCompassPanel(root) {
    if (IsValidPanel(g_compassPanel)) return g_compassPanel;

    var existing = root.FindChildTraverse("VindictaCompassTape");
    if (existing) {
      g_compassPanel = existing;
      return g_compassPanel;
    }

    var panel = $.CreatePanel("Image", root, "VindictaCompassTape");
    panel.SetImage("s2r://panorama/images/hud/crosshair/compass_psd.vtex");
    
    panel.style.horizontalAlign = "center";
    panel.style.verticalAlign = "top";
    panel.style.marginTop = "150px";       
    
    panel.style.width = "4872px";         
    panel.style.height = "45px";          
    panel.style.minWidth = "4872px";      
    panel.style.maxWidth = "4872px";
    
    panel.style.overflow = "noclip";      
    panel.style.visibility = "collapse";  
    panel.style.opacity = "0.0";
    
    // Native C++ render flag to definitively hide it on creation
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

    // Left Ladder: Centered on screen, pushed left by percentage of panel width
    var leftPanel = $.CreatePanel("Image", root, "VindictaLadderLeft");
    leftPanel.SetImage("s2r://panorama/images/hud/crosshair/ladder_psd.vtex");
    leftPanel.style.horizontalAlign = "center";
    leftPanel.style.verticalAlign = "center";
    leftPanel.style.transform = "translateX(-30%)"; // Tweak percentage (-400%, -500%, etc.)
    leftPanel.style.width = "76px";
    leftPanel.style.height = "1344px";
    leftPanel.style.opacity = "0.0";
    leftPanel.style.overflow = "noclip";

    // Right Ladder: Centered on screen, pushed right by percentage of panel width
    var rightPanel = $.CreatePanel("Image", root, "VindictaLadderRight");
    rightPanel.SetImage("s2r://panorama/images/hud/crosshair/ladder_psd.vtex");
    rightPanel.style.horizontalAlign = "center";
    rightPanel.style.verticalAlign = "center";
    rightPanel.style.transform = "translateX(30%)"; // Tweak percentage (400%, 500%, etc.)
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
    
    // Use 0.001 opacity. This makes it invisible to the human eye, but the 
    // engine still thinks it's rendering on-screen and will keep updating the value!
    if (localProgress && localProgress.style && localProgress.style.opacity !== "0.001") {
      localProgress.style.opacity = "0.001";
      localProgress.style.transform = null; // Clear any old off-screen transforms
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
              
              // EARLY SANITY CHECK: Calculate aim state immediately
              var rawVal = progressInfo.value;
              var nextOpacity = (typeof rawVal === "number" && !isNaN(rawVal)) ? rawVal : 0.0;
              var isAiming = nextOpacity > 0.0;

              // ENGINE FAILSAFE 1: Deep visibility checks
              try {
                if (g_progressElement && (g_progressElement.style.visibility === "collapse" || g_progressElement.BHasClass("Hidden") || g_progressElement.actualvisibility === "collapse" || g_progressElement.visible === false)) {
                  isAiming = false;
                }
                var tempScope = GetScopeImg(root);
                if (tempScope && (tempScope.style.visibility === "collapse" || tempScope.BHasClass("Hidden") || tempScope.actualvisibility === "collapse" || tempScope.visible === false)) {
                  isAiming = false;
                }
              } catch (e) {}

              // ENGINE FAILSAFE 2: Freeze Detection (6 frames)
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

              // Actively hunt down any leftover compass panel by ID and destroy it
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
              if (scopeImg) {
                var chevrons = GetOrCreateChevronPanels(scopeImg);
                var statusText = GetOrCreateStatusPanels(scopeImg);
                
                // FIXED: Passing 'root' instead of 'scopeImg' so it doesn't get clipped!
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
                    
                    var currentYaw = GetMinimapYaw(root) - 90.0; 
                    if (currentYaw > 180) currentYaw -= 360;
                    if (currentYaw < -180) currentYaw += 360;

                    var TOTAL_DEGREES = 720; 
                    var IMAGE_WIDTH_PX = 4872;
                    var PX_PER_DEGREE = IMAGE_WIDTH_PX / TOTAL_DEGREES;

                    var compassOffsetPx = currentYaw * PX_PER_DEGREE;

                    compass.style.washColor = "#00FF66";
                    compass.style.imgShadow = g_cachedCrtShadow;
                    compass.visible = true;
                    compass.style.visibility = "visible";
                    compass.style.opacity = "1.0";
                    compass.style.transform = "translateX(" + (-compassOffsetPx) + "px)";

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

                    // Ladders Drift Logic
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

                  } else {
                    if (IsValidPanel(g_compassPanel)) {
                      g_compassPanel.DeleteAsync(0);
                      g_compassPanel = null;
                    }
                    
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
    if (IsValidPanel(g_chevronLeft)) g_chevronLeft.DeleteAsync(0);
    if (IsValidPanel(g_chevronRight)) g_chevronRight.DeleteAsync(0);
    if (IsValidPanel(g_statusLock)) g_statusLock.DeleteAsync(0);
    if (IsValidPanel(g_statusFire)) g_statusFire.DeleteAsync(0);
    if (IsValidPanel(g_compassPanel)) g_compassPanel.DeleteAsync(0);
    
    g_chevronLeft = null;
    g_chevronRight = null;
    g_statusLock = null;
    g_statusFire = null;
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