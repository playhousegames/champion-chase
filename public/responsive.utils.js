/* =========================================================
   SUSHI SPRINT – RESPONSIVE UTILITIES
   Add this to the TOP of your game.js file (after socket.io import)
   OR include as a separate <script src="responsive-utils.js"></script>
   before game.js in your HTML
   ========================================================= */

// Responsive Game Manager
var ResponsiveGame = {
  // Configuration
  config: {
    baseRunnerSize: 32,
    minRunnerSize: 28,
    maxRunnerSize: 56,
    baseTrackHeight: 400,
    updateInterval: null
  },
  
  // Get current CSS custom property value
  getCSSVar: function(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  },
  
  // Get runner size from CSS variable
  getRunnerSize: function() {
    const size = parseInt(this.getCSSVar('--runner-size'));
    return isNaN(size) ? this.config.baseRunnerSize : size;
  },
  
  // Get game scale from CSS variable
  getGameScale: function() {
    const scale = parseFloat(this.getCSSVar('--game-scale'));
    return isNaN(scale) ? 1 : scale;
  },
  
  // Get track height
  getTrackHeight: function() {
    const track = document.querySelector('.track-container');
    return track ? track.offsetHeight : this.config.baseTrackHeight;
  },
  
  // Get safe area insets
  getSafeAreas: function() {
    return {
      top: parseInt(this.getCSSVar('--sat')) || 0,
      right: parseInt(this.getCSSVar('--sar')) || 0,
      bottom: parseInt(this.getCSSVar('--sab')) || 0,
      left: parseInt(this.getCSSVar('--sal')) || 0
    };
  },
  
  // Update all runner sizes to match current responsive settings
  updateRunnerSizes: function() {
    const runnerSize = this.getRunnerSize();
    
    for (let i = 1; i <= 4; i++) {
      const runner = document.getElementById('runner' + i);
      if (runner) {
        runner.style.width = runnerSize + 'px';
        runner.style.height = runnerSize + 'px';
      }
    }
    
    console.log('[Responsive] Updated runner sizes to:', runnerSize + 'px');
  },
  
  // Calculate responsive track width based on device
  getResponsiveTrackWidth: function() {
    const vw = window.innerWidth;
    const scale = this.getGameScale();
    
    // Base track width scaled by device capability
    // Smaller devices get shorter tracks for better performance
    let baseWidth = 12000;
    
    if (vw < 375) {
      baseWidth = 8000;
    } else if (vw < 768) {
      baseWidth = 10000;
    }
    
    return Math.round(baseWidth * scale);
  },
  
  // Position runners in their lanes with responsive vertical positioning
  positionRunnerInLane: function(runnerId, laneNumber) {
    const runner = document.getElementById('runner' + runnerId);
    if (!runner) return;
    
    const trackHeight = this.getTrackHeight();
    const runnerSize = this.getRunnerSize();
    
    // Calculate lane height (track divided into 4 lanes)
    const laneHeight = trackHeight / 4;
    
    // Center runner vertically in its lane
    const laneIndex = laneNumber - 1; // 0-based
    const topPosition = (laneIndex * laneHeight) + (laneHeight - runnerSize) / 2;
    
    runner.style.top = topPosition + 'px';
  },
  
  // Position all runners in their lanes
  positionAllRunners: function() {
    for (let i = 1; i <= 4; i++) {
      this.positionRunnerInLane(i, i);
    }
    console.log('[Responsive] Positioned all runners in lanes');
  },
  
  // Update name labels to be positioned correctly above runners
  updateNameLabelPositions: function() {
    const runnerSize = this.getRunnerSize();
    const scale = this.getGameScale();
    
    document.querySelectorAll('.name-label').forEach(label => {
      const runnerId = label.closest('.runner')?.id?.replace('runner', '');
      if (runnerId) {
        const runner = document.getElementById('runner' + runnerId);
        if (runner) {
          // Position name label above runner
          label.style.fontSize = (0.75 * scale) + 'rem';
          label.style.top = '-' + (runnerSize * 0.4) + 'px';
        }
      }
    });
  },
  
  // Handle device orientation changes
  handleOrientationChange: function() {
    console.log('[Responsive] Orientation changed, recalculating layout');
    
    setTimeout(() => {
      this.updateRunnerSizes();
      this.positionAllRunners();
      this.updateNameLabelPositions();
      
      // Update track width if needed
      if (typeof gameState !== 'undefined') {
        const newTrackWidth = this.getResponsiveTrackWidth();
        gameState.trackWidth = newTrackWidth;
        
        const track = document.getElementById('track');
        if (track) {
          track.style.width = newTrackWidth + 'px';
        }
      }
    }, 100); // Small delay to let CSS recalculate
  },
  
  // Initialize responsive features
  init: function() {
    console.log('[Responsive] Initializing responsive game features');
    
    // Set initial track width
    if (typeof gameState !== 'undefined') {
      gameState.trackWidth = this.getResponsiveTrackWidth();
    }
    
    // Update sizes immediately
    this.updateRunnerSizes();
    this.positionAllRunners();
    
    // Listen for resize events
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.updateRunnerSizes();
        this.positionAllRunners();
        this.updateNameLabelPositions();
      }, 100);
    });
    
    // Listen for orientation changes
    window.addEventListener('orientationchange', () => {
      this.handleOrientationChange();
    });
    
    // Monitor for runner creation/updates
    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node.classList && node.classList.contains('runner')) {
              const runnerId = node.id.replace('runner', '');
              if (runnerId) {
                this.positionRunnerInLane(runnerId, parseInt(runnerId));
              }
            }
          });
        });
      });
      
      const track = document.getElementById('track');
      if (track) {
        observer.observe(track, { childList: true, subtree: true });
      }
    }
    
    console.log('[Responsive] Responsive features initialized', {
      runnerSize: this.getRunnerSize(),
      gameScale: this.getGameScale(),
      trackHeight: this.getTrackHeight(),
      trackWidth: typeof gameState !== 'undefined' ? gameState.trackWidth : 'N/A',
      safeAreas: this.getSafeAreas()
    });
  }
};

// Patch the sprite manager to respect responsive sizing
if (typeof spriteManager !== 'undefined') {
  const originalUpdateRunnerSprite = spriteManager.updateRunnerSprite;
  spriteManager.updateRunnerSprite = function(playerId) {
    originalUpdateRunnerSprite.call(this, playerId);
    
    // Apply responsive size after sprite update
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      const runnerSize = ResponsiveGame.getRunnerSize();
      runner.style.width = runnerSize + 'px';
      runner.style.height = runnerSize + 'px';
    }
  };
  
  const originalEnsureAllSpritesVisible = spriteManager.ensureAllSpritesVisible;
  spriteManager.ensureAllSpritesVisible = function() {
    originalEnsureAllSpritesVisible.call(this);
    
    // Apply responsive sizes after ensuring visibility
    ResponsiveGame.updateRunnerSizes();
    ResponsiveGame.positionAllRunners();
  };
}

// Enhanced debug info for responsive issues
function logResponsiveDebug() {
  console.group('[Responsive Debug]');
  console.log('Viewport:', {
    width: window.innerWidth,
    height: window.innerHeight,
    aspectRatio: (window.innerWidth / window.innerHeight).toFixed(2)
  });
  console.log('CSS Variables:', {
    runnerSize: ResponsiveGame.getCSSVar('--runner-size'),
    gameScale: ResponsiveGame.getCSSVar('--game-scale'),
    trackHeight: ResponsiveGame.getCSSVar('--track-height'),
    safeAreaTop: ResponsiveGame.getCSSVar('--sat'),
    safeAreaBottom: ResponsiveGame.getCSSVar('--sab')
  });
  console.log('Computed Values:', {
    runnerSize: ResponsiveGame.getRunnerSize(),
    gameScale: ResponsiveGame.getGameScale(),
    trackHeight: ResponsiveGame.getTrackHeight(),
    trackWidth: typeof gameState !== 'undefined' ? gameState.trackWidth : 'N/A'
  });
  
  // Check all runners
  for (let i = 1; i <= 4; i++) {
    const runner = document.getElementById('runner' + i);
    if (runner) {
      console.log('Runner ' + i + ':', {
        width: runner.style.width,
        height: runner.style.height,
        top: runner.style.top,
        left: runner.style.left
      });
    }
  }
  console.groupEnd();
}

// Make debug function globally available
window.logResponsiveDebug = logResponsiveDebug;

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    ResponsiveGame.init();
  });
} else {
  // DOM already loaded
  ResponsiveGame.init();
}

// Also initialize after a short delay to ensure everything is loaded
setTimeout(function() {
  ResponsiveGame.init();
}, 500);

console.log('[Responsive] Responsive utilities loaded. Call logResponsiveDebug() to see debug info.');