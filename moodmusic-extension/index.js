// --- START OF FILE index.js ---

import { getContext } from '../../../extensions.js';
import { eventSource, event_types, generateQuietPrompt, generateRaw, token } from '../../../../script.js';

const extensionName = "SillyTavern-Spotify-Music-Extension";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const PLUGIN_API_BASE = '/api/plugins/moodmusic';
const LOG_PREFIX = "[Spotify Music]";

// Configuration and State Variables
const MUSIC_PRESET_NAME = "Music";
const POLLING_INTERVAL_MS = 10000;
const MOOD_ANALYSIS_TRIGGER_THRESHOLD_MS = 10000;
const HISTORY_FOR_MOOD_ANALYSIS = 8;

let isInitialized = false;
let isAuthenticated = false; // Spotify login status
let areServerCredentialsSet = false; // Server-side Spotify App Client ID/Secret status
let isPollingPlayback = false;
let pollingIntervalId = null;
let currentlyPlayingTrackUri = null;
let currentPresetRestorationRequired = false;
let originalPresetName = null;
let $presetDropdown = null; // Cached jQuery object for the preset dropdown
let lastPlaybackStopTime = 0;
let isAnalysisInProgress = false;
let isExtensionActive = true;
let lastProcessedMessageId = null;
let analysisTimeout = null;
let useMusicPreset = true; // true = use Music.json preset, false = use current model
let useLikedSongsFallback = true; // Use Liked Songs as fallback when AI suggestions aren't found
let lastAnalysisTime = 0;
const MIN_ANALYSIS_INTERVAL_MS = 3000; // Minimum 3 seconds between analyses
let isAutoTriggerSetup = false; // Prevent duplicate event listener setup
let lastEventTimestamp = 0; // Track last event to prevent rapid-fire events
let currentRequestId = null; // Track the current request to prevent overlaps
let requestCounter = 0; // Counter for unique request IDs

// Helper to get standard API headers with CSRF token
function getApiHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    };
}


// UI Update Functions
function updateCredentialsStatusUI(status) {
    const credsStatusText = $('#moodmusic-creds-status');
    const loginButton = $('#moodmusic-login-button');
    if (!credsStatusText.length) { console.warn(`${LOG_PREFIX} [updateCredsUI] Creds status UI not found.`); return; }

    if (status && status.clientIdSet && status.clientSecretSet) {
        credsStatusText.text('Saved ✓').css('color', 'lightgreen');
        areServerCredentialsSet = true;
        loginButton.prop('disabled', false).attr('title', 'Login to Spotify');
    } else {
        let msg = 'Not Set';
        if (status && status.clientIdSet && !status.clientSecretSet) msg = 'Client Secret Missing';
        else if (status && !status.clientIdSet && status.clientSecretSet) msg = 'Client ID Missing';
        credsStatusText.text(msg).css('color', 'coral');
        areServerCredentialsSet = false;
        loginButton.prop('disabled', true).attr('title', 'Spotify credentials not set on server.');
    }
     updateAuthStatusUI(isAuthenticated, areServerCredentialsSet);
}

function updateAuthStatusUI(loggedIn, serverCredsAreSet = areServerCredentialsSet) {
    const statusText = $('#moodmusic-status');
    const loginButton = $('#moodmusic-login-button');
    if (!statusText.length || !loginButton.length) { console.warn(`${LOG_PREFIX} [updateAuthStatusUI] UI elements not found.`); return; }

    isAuthenticated = loggedIn;

    if (!serverCredsAreSet) {
        statusText.text('Configure Credentials').css('color', 'orange');
        loginButton.hide();
    } else if (loggedIn) {
        statusText.text('Logged In').css('color', 'lightgreen');
        loginButton.hide();
    } else {
        statusText.text('Not Logged In').css('color', 'coral');
        loginButton.show().prop('disabled', false);
    }

    const previousIsAuthenticated = window.moodMusicPreviousIsAuthenticated || false;
    window.moodMusicPreviousIsAuthenticated = loggedIn;

    if (previousIsAuthenticated !== loggedIn) {
        console.log(`${LOG_PREFIX} Auth state changed from ${previousIsAuthenticated} to: ${loggedIn}`);
        if (!loggedIn && isPollingPlayback) {
            stopPlaybackPolling();
        } else if (loggedIn && !isPollingPlayback && isInitialized && isExtensionActive && !pollingIntervalId && areServerCredentialsSet) {
            console.log(`${LOG_PREFIX} Starting polling interval after login or credential setup.`);
            if (pollingIntervalId) clearInterval(pollingIntervalId); // Clear just in case
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
        }
    }
    isAuthenticated = loggedIn;
}


function updateToggleButtonUI() {
    const $button = $('#moodmusic-toggle-button');
    if (!$button.length) return;
    if (isExtensionActive) {
        $button.html('<i class="fa-solid fa-pause"></i> Pause Music').removeClass('success_button').addClass('menu_button');
    } else {
        $button.html('<i class="fa-solid fa-play"></i> Resume Music').removeClass('menu_button').addClass('success_button');
    }
}

// Model switching functionality
function switchModelMode() {
    useMusicPreset = !useMusicPreset;
    updateModelStatusUI();

    const mode = useMusicPreset ? 'Music.json preset' : 'current main model';
    toastr.info(`Spotify Music: Switched to ${mode}`);
    console.log(`${LOG_PREFIX} Model mode switched to: ${mode}`);
}

function updateModelStatusUI() {
    const statusText = useMusicPreset ? 'Music.json preset' : 'Current main model';
    $('#moodmusic-model-status').text(statusText);
}

// Liked Songs fallback functionality
function loadLikedSongsSettings() {
    const saved = localStorage.getItem('moodmusic_use_liked_fallback');
    if (saved !== null) {
        useLikedSongsFallback = JSON.parse(saved);
    }
    $('#moodmusic-use-liked-fallback').prop('checked', useLikedSongsFallback);
}

function saveLikedSongsSettings() {
    useLikedSongsFallback = $('#moodmusic-use-liked-fallback').prop('checked');
    localStorage.setItem('moodmusic_use_liked_fallback', JSON.stringify(useLikedSongsFallback));
    console.log(`${LOG_PREFIX} Liked Songs fallback setting saved: ${useLikedSongsFallback}`);
}

async function testLikedSongs() {
    if (!isAuthenticated) {
        toastr.error("Spotify Music: Cannot test - not logged into Spotify");
        return;
    }

    console.log(`${LOG_PREFIX} Testing Liked Songs playback`);
    toastr.info("Spotify Music: Testing your Liked Songs...");

    try {
        const success = await requestPlayLikedSongs();
        if (success) {
            toastr.success("Spotify Music: Successfully started playing your Liked Songs!");
        }
    } catch (error) {
        console.error(`${LOG_PREFIX} Error testing Liked Songs:`, error);
        toastr.error("Spotify Music: Failed to test Liked Songs");
    }
}

async function requestPlayLikedSongs() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [requestPlayLikedSongs]`;

    if (!isAuthenticated) {
        toastr.error("Spotify Music: Cannot play - not logged into Spotify");
        return false;
    }

    try {
        const response = await fetch(`${PLUGIN_API_BASE}/play/liked`, {
            method: 'POST',
            headers: getApiHeaders()
        });

        const data = await response.json();
        if (!response.ok) {
            let errorMsg = data.message || `Failed to play liked songs (HTTP ${response.status})`;
            toastr.error(`Spotify Music: ${errorMsg}`);
            if (data.needsLogin) await checkAuthStatus();
            if (data.needsConfiguration) await loadCredentialsStatus();
            return false;
        }

        console.log(`${LOG_PREFIX_FUNC} Successfully started playing liked songs: ${data.message}`);
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Network/other error during liked songs request:`, error);
        toastr.error(`Spotify Music: ${error.message || 'Request failed'}`);
        return false;
    }
}// API Calls to Server Plugin
async function loadCredentialsStatus() {
    try {
        const response = await fetch(`${PLUGIN_API_BASE}/config`, { method: 'GET' });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        updateCredentialsStatusUI(data);

        // Display existing credentials in masked format if they exist
        if (data.clientIdSet && data.clientId) {
            $('#moodmusic-client-id').val(data.clientId);
            $('#moodmusic-client-id').attr('placeholder', 'Client ID (saved)');
        } else {
            $('#moodmusic-client-id').val('');
            $('#moodmusic-client-id').attr('placeholder', 'Spotify Client ID');
        }

        if (data.clientSecretSet && data.clientSecret) {
            // Show masked version of client secret
            $('#moodmusic-client-secret').val(data.clientSecret);
            $('#moodmusic-client-secret').attr('placeholder', 'Client Secret (saved)');
        } else {
            $('#moodmusic-client-secret').val('');
            $('#moodmusic-client-secret').attr('placeholder', 'Spotify Client Secret');
        }

        console.log(`${LOG_PREFIX} Credential status loaded:`, data);
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to load credential status:`, error);
        updateCredentialsStatusUI({ clientIdSet: false, clientSecretSet: false });
        toastr.error("Spotify Music: Failed to load credential status");
    }
}

async function saveSpotifyCredentials() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [saveSpotifyCredentials]`;
    const clientId = $('#moodmusic-client-id').val();
    const clientSecret = $('#moodmusic-client-secret').val();

    if (!clientId || !clientSecret) {
        toastr.error("Spotify Music: Client ID and Client Secret are required");
        return;
    }

    try {
        const response = await fetch(`${PLUGIN_API_BASE}/config`, {
            method: 'POST',
            headers: getApiHeaders(), // This now works correctly
            body: JSON.stringify({ clientId, clientSecret }),
        });

        if (!response.ok) {
            let errorText = `Server error: ${response.status} ${response.statusText}`;
            try {
                const errorJson = await response.json();
                if (errorJson && errorJson.message) {
                    errorText = errorJson.message;
                }
            } catch (e) {
                if (response.status === 403) {
                    errorText = 'Forbidden. CSRF token invalid. Please refresh the page and try again.';
                }
            }
            throw new Error(errorText);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || 'Operation failed with an unspecified error.');
        }

        toastr.success("Spotify Music: Spotify credentials saved successfully");
        console.log(`${LOG_PREFIX_FUNC} Credentials saved and will persist between sessions.`);
        // Don't clear the fields - let loadCredentialsStatus show the saved values
        await loadCredentialsStatus();
        await checkAuthStatus();
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Error saving credentials:`, error);
        toastr.error(`Spotify Music: Error saving credentials - ${error.message}`);
    }
}

async function clearSpotifyCredentials() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [clearSpotifyCredentials]`;

    if (!confirm('Are you sure you want to clear saved Spotify credentials? This will require you to re-enter them.')) {
        return;
    }

    try {
        const response = await fetch(`${PLUGIN_API_BASE}/config`, {
            method: 'DELETE',
            headers: getApiHeaders(),
        });

        if (!response.ok) {
            let errorText = `Server error: ${response.status} ${response.statusText}`;
            try {
                const errorJson = await response.json();
                if (errorJson && errorJson.message) {
                    errorText = errorJson.message;
                }
            } catch (e) {
                // Fallback error message
            }
            throw new Error(errorText);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error(data.message || 'Operation failed with an unspecified error.');
        }

        toastr.success("Spotify Music: Spotify credentials cleared");
        console.log(`${LOG_PREFIX_FUNC} Credentials cleared successfully.`);

        // Clear the UI fields
        $('#moodmusic-client-id').val('').attr('placeholder', 'Spotify Client ID');
        $('#moodmusic-client-secret').val('').attr('placeholder', 'Spotify Client Secret');

        await loadCredentialsStatus();
        await checkAuthStatus();
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Error clearing credentials:`, error);
        toastr.error(`Spotify Music: Error clearing credentials - ${error.message}`);
    }
}

async function checkAuthStatus() {
    try {
        const response = await fetch(`${PLUGIN_API_BASE}/auth/status`, { method: 'GET' });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        areServerCredentialsSet = data.credentialsSet;
        updateAuthStatusUI(data.loggedIn, data.credentialsSet);
    } catch (error) {
        console.error(`${LOG_PREFIX} checkAuthStatus failed:`, error);
        updateAuthStatusUI(false, areServerCredentialsSet);
    }
}

async function triggerSpotifyLogin() {
    if (!areServerCredentialsSet) {
        toastr.error("Spotify Music: Cannot login - Spotify credentials are not configured");
        return;
    }
    try {
        const loginUrl = `${PLUGIN_API_BASE}/auth/login`;
        const popupWidth = 600, popupHeight = 700;
        const left = (window.screen.width / 2) - (popupWidth / 2);
        const top = (window.screen.height / 2) - (popupHeight / 2);
        const popup = window.open(loginUrl, 'SpotifyLogin', `width=${popupWidth},height=${popupHeight},left=${left},top=${top},scrollbars=yes`);

        const checkPopupClosed = setInterval(async () => {
            if (!popup || popup.closed) {
                clearInterval(checkPopupClosed);
                console.log(`${LOG_PREFIX} Login popup closed. Re-checking auth...`);
                setTimeout(checkAuthStatus, 1500);
            }
        }, 1000);
    } catch (error) {
        console.error(`${LOG_PREFIX} Error in triggerSpotifyLogin:`, error);
        toastr.error(`Spotify Music: Login failed - ${error.message}`);
    }
}

async function getPlaybackState() {
    if (!isAuthenticated) return null;
    try {
        const response = await fetch(`${PLUGIN_API_BASE}/playback/state`, { method: 'GET' });
        if (response.status === 401) {
            console.warn(`${LOG_PREFIX} Got 401. Re-checking auth.`); await checkAuthStatus(); return null;
        }
        if (!response.ok) { console.error(`${LOG_PREFIX} HTTP error getting playback state: ${response.status}`); return null; }
        return await response.json();
    } catch (error) { console.error(`${LOG_PREFIX} Network error getting playback state:`, error); return null; }
}

function startPlaybackPolling(trackUri) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [startPlaybackPolling]`;
    if (!isExtensionActive) { console.log(`${LOG_PREFIX_FUNC} Not starting: extension paused.`); return; }
    if (isPollingPlayback) return;
    if (!isAuthenticated || !trackUri) return;
    console.log(`${LOG_PREFIX_FUNC} Starting polling for URI: ${trackUri}`);
    currentlyPlayingTrackUri = trackUri; isPollingPlayback = true;
}

function stopPlaybackPolling() {
    if (!isPollingPlayback) return;
    console.log(`${LOG_PREFIX} [stopPlaybackPolling] Stopping polling.`);
    isPollingPlayback = false; currentlyPlayingTrackUri = null;
}

async function pollPlaybackState() {
    if (!isExtensionActive || !isAuthenticated) return;

    const state = await getPlaybackState();
    if (!state) {
        if (isPollingPlayback) {
            console.warn(`${LOG_PREFIX} Polling stopped due to state error.`);
            stopPlaybackPolling();
            lastPlaybackStopTime = Date.now();
            if (currentPresetRestorationRequired) await restoreOriginalPreset();
        }
        return;
    }

    const isTargetTrackActive = isPollingPlayback && state.is_playing && state.item?.uri === currentlyPlayingTrackUri;

    if (isTargetTrackActive) {
        lastPlaybackStopTime = 0; // Reset timer if our track is playing
    } else {
        if (isPollingPlayback) { // Our track just stopped
            console.log(`${LOG_PREFIX} Target track stopped/ended.`);
            stopPlaybackPolling();
            lastPlaybackStopTime = Date.now();
            await restoreOriginalPreset(); // Restore preset right away
            // Note: Automatic triggering now happens on character responses instead of inactivity
            console.log(`${LOG_PREFIX} Target track ended. Auto-trigger will happen on next character response.`);
        } else if (!state.is_playing) { // Nothing is playing
            if (lastPlaybackStopTime === 0) lastPlaybackStopTime = Date.now();
            // Note: Removed inactivity triggering - now relies on character response triggering
            console.log(`${LOG_PREFIX} No music playing. Auto-trigger will happen on next character response.`);
        } else { // Unrelated music is playing
             lastPlaybackStopTime = Date.now(); // Keep pushing back the timer
        }
    }
}

// --- Preset Management ---
function findAndStorePresetDropdown() {
    const dropdownId = '#settings_preset_openai';
    const $foundDropdown = $(dropdownId);
    if ($foundDropdown.length) {
        $presetDropdown = $foundDropdown;
    } else {
        console.error(`${LOG_PREFIX} Could NOT find preset dropdown element: ${dropdownId}.`);
    }
}

function getCurrentPresetNameFromUi() {
    if (!$presetDropdown || !$presetDropdown.length) findAndStorePresetDropdown();
    if (!$presetDropdown || !$presetDropdown.length) {
        console.error(`${LOG_PREFIX} Dropdown object is invalid. Cannot get current preset.`);
        return null;
    }
    return $presetDropdown.find('option:selected').text().trim();
}

async function setPresetViaUi(presetName) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [setPresetViaUi]`;
    if (!$presetDropdown || !$presetDropdown.length) {
        console.error(`${LOG_PREFIX_FUNC} Cannot find preset dropdown. Aborting switch.`);
        return false;
    }
    const $targetOption = $presetDropdown.find('option').filter(function() {
        return $(this).text().trim() === presetName;
    });

    if ($targetOption.length) {
        const targetValue = $targetOption.val();
        if ($presetDropdown.val() === targetValue) {
            console.log(`${LOG_PREFIX_FUNC} Preset "${presetName}" is already selected.`);
            return true;
        }
        $presetDropdown.val(targetValue).trigger('change');
        await new Promise(resolve => setTimeout(resolve, 200)); // UI reaction time
        if ($presetDropdown.val() === targetValue) {
            console.log(`${LOG_PREFIX_FUNC} Successfully switched to preset "${presetName}".`);
            return true;
        } else {
            console.error(`${LOG_PREFIX_FUNC} Verification failed after attempting to set preset "${presetName}".`);
            return false;
        }
    } else {
        console.error(`${LOG_PREFIX_FUNC} Could not find preset option: "${presetName}".`);
        return false;
    }
}

// OPTIMIZED: Centralized preset restoration logic
async function restoreOriginalPreset() {
    if (currentPresetRestorationRequired && originalPresetName) {
        console.log(`${LOG_PREFIX} Restoring original preset: ${originalPresetName}`);
        const restored = await setPresetViaUi(originalPresetName);
        if (!restored) {
             console.error(`${LOG_PREFIX} CRITICAL: FAILED TO RESTORE ORIGINAL PRESET "${originalPresetName}".`);
             toastr.error("Spotify Music: Failed to restore preset - please check manually");
        }
    } else if (currentPresetRestorationRequired && !originalPresetName) {
        console.error(`${LOG_PREFIX} Preset restoration required, but original preset name was not captured.`);
        toastr.warning("Spotify Music: Original preset unknown - please check preset settings");
    }
    // Reset flags regardless of outcome
    currentPresetRestorationRequired = false;
    originalPresetName = null;
}

// --- AI Interaction ---
async function getMusicSuggestionFromAI(chatHistorySnippet) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [getMusicSuggestionFromAI]`;
    const modelMode = useMusicPreset ? 'Music.json preset' : 'current main model';
    console.log(`${LOG_PREFIX_FUNC} Requesting music suggestion using ${modelMode}...`);

    if (useMusicPreset) {
        // Use Music.json preset
        const switched = await setPresetViaUi(MUSIC_PRESET_NAME);
        if (!switched) {
            console.error(`${LOG_PREFIX_FUNC} Failed to switch to preset "${MUSIC_PRESET_NAME}". Skipping AI call.`);
            return null;
        }
        currentPresetRestorationRequired = true;

        try {
            console.log(`${LOG_PREFIX_FUNC} Triggering Music preset...`);
            const aiResponseText = await generateQuietPrompt('', false, false, {
                source: 'moodmusic-extension'
            });

            console.log(`${LOG_PREFIX_FUNC} Raw AI response:`, aiResponseText);

            if (!aiResponseText || typeof aiResponseText !== 'string' || aiResponseText.trim() === '') {
                throw new Error("AI call returned an empty or invalid response.");
            }
            return aiResponseText.trim();
        } catch (error) {
            console.error(`${LOG_PREFIX_FUNC} Error during AI music suggestion with Music preset:`, error);
            toastr.error(`Spotify Music: AI suggestion failed - ${error.message}`);
            return null;
        }
    } else {
        // Use current main model with custom prompt
        try {
            console.log(`${LOG_PREFIX_FUNC} Using current main model with custom music analysis prompt...`);

            const musicPrompt = `Based on the following conversation, suggest a single song that matches the current mood and atmosphere. Please respond in this exact format:

Song: [Artist Name] - [Song Title]

Recent conversation:
${chatHistorySnippet}

Choose a song that captures the emotional tone, energy level, and overall vibe of this conversation. Focus on the most recent messages to understand the current mood.`;

            const aiResponseText = await generateQuietPrompt(musicPrompt, false, false, {
                source: 'moodmusic-extension'
            });

            console.log(`${LOG_PREFIX_FUNC} Raw AI response:`, aiResponseText);

            if (!aiResponseText || typeof aiResponseText !== 'string' || aiResponseText.trim() === '') {
                throw new Error("AI call returned an empty or invalid response.");
            }
            return aiResponseText.trim();
        } catch (error) {
            console.error(`${LOG_PREFIX_FUNC} Error during AI music suggestion with current model:`, error);
            toastr.error(`Spotify Music: AI suggestion failed - ${error.message}`);
            return null;
        }
    }
}


function parseMusicFromAiResponse(aiResponseText) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [parseMusicFromAiResponse]`;

    if (!aiResponseText || typeof aiResponseText !== 'string') {
        console.error(`${LOG_PREFIX_FUNC} Invalid AI response: empty or not a string`);
        return null;
    }

    console.log(`${LOG_PREFIX_FUNC} Parsing AI response: "${aiResponseText}"`);

    // Try multiple parsing patterns to be more flexible
    let titleMatch = aiResponseText.match(/Title:\s*(.*?)(?:\n|$)/i);
    let artistMatch = aiResponseText.match(/Artist:\s*(.*?)(?:\n|$)/i);

    // Alternative patterns if the first ones don't work
    if (!titleMatch) {
        titleMatch = aiResponseText.match(/Song:\s*(.*?)(?:\n|$)/i) ||
                    aiResponseText.match(/Track:\s*(.*?)(?:\n|$)/i) ||
                    aiResponseText.match(/"([^"]+)"\s*by\s*/i);
    }

    if (!artistMatch && titleMatch) {
        artistMatch = aiResponseText.match(/by\s+(.*?)(?:\n|$)/i);
    }

    const title = titleMatch ? titleMatch[1].trim().replace(/["""]/g, '') : null;
    const artist = artistMatch ? artistMatch[1].trim().replace(/["""]/g, '') : null;

    if (title) {
        const result = { title, artist: artist || 'Unknown Artist' };
        console.log(`${LOG_PREFIX_FUNC} Successfully parsed:`, result);
        return result;
    }

    console.warn(`${LOG_PREFIX_FUNC} Could not parse song info from AI response: "${aiResponseText}"`);
    toastr.warning("Spotify Music: Could not parse song from AI response");
    return null;
}

async function requestPlaySong(suggestion, isOriginalRequest = true) {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [requestPlaySong]`;
    if (!isAuthenticated) { toastr.error("MoodMusic: Cannot play - not logged into Spotify"); return false; }
    if (!suggestion || !suggestion.title) { console.error(`${LOG_PREFIX_FUNC} Invalid suggestion.`); return false; }

    try {
        const response = await fetch(`${PLUGIN_API_BASE}/play`, {
            method: 'POST',
            headers: getApiHeaders(), // This now works correctly
            body: JSON.stringify({ suggestion: suggestion })
        });

        const data = await response.json();
        if (!response.ok) {
            let errorMsg = data.message || `Play request failed (HTTP ${response.status})`;

            // Check if song wasn't found and we should use liked songs fallback
            if (isOriginalRequest && useLikedSongsFallback && (
                data.message?.includes('not found') ||
                data.message?.includes('No tracks found') ||
                data.message?.includes('Could not find') ||
                response.status === 404
            )) {
                console.log(`${LOG_PREFIX_FUNC} Original song not found, trying Liked Songs fallback`);
                toastr.warning(`MoodMusic: "${suggestion.artist} - ${suggestion.title}" not found, playing from your Liked Songs`);

                return await requestPlayLikedSongs();
            }

            toastr.error(`MoodMusic: ${errorMsg}`);
            if (data.needsLogin) await checkAuthStatus();
            if (data.needsConfiguration) await loadCredentialsStatus();
            return false;
        }

        console.log(`${LOG_PREFIX_FUNC} Play request successful: ${data.message}`);

        if (data.success && data.trackUri) startPlaybackPolling(data.trackUri);
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} Network/other error during play request:`, error);
        toastr.error(`MoodMusic: ${error.message || 'Request failed'}`);
        return false;
    }
}

async function triggerMoodAnalysisAndPlay() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [triggerMoodAnalysisAndPlay]`;

    // Check basic conditions
    if (isAnalysisInProgress || !isExtensionActive || !isAuthenticated) {
        console.log(`${LOG_PREFIX_FUNC} Aborted (Analysis running: ${isAnalysisInProgress}, Active: ${isExtensionActive}, Auth: ${isAuthenticated})`);
        return true; // Return true to avoid error popup for expected conditions
    }

    // Prevent rapid-fire analyses
    const now = Date.now();
    if (now - lastAnalysisTime < MIN_ANALYSIS_INTERVAL_MS) {
        console.log(`${LOG_PREFIX_FUNC} Aborted - too soon since last analysis (${now - lastAnalysisTime}ms < ${MIN_ANALYSIS_INTERVAL_MS}ms)`);
        return true; // Return true to avoid error popup for expected throttling
    }

    // Generate unique request ID
    const requestId = ++requestCounter;
    const updatedLogPrefix = `${LOG_PREFIX} [triggerMoodAnalysisAndPlay-${requestId}]`;

    console.log(`${updatedLogPrefix} Starting mood analysis sequence...`);

    // Atomic check for exclusive access
    if (isAnalysisInProgress || currentRequestId !== null) {
        console.log(`${updatedLogPrefix} BLOCKED - Analysis already in progress (flag: ${isAnalysisInProgress}, currentRequest: ${currentRequestId})`);
        return true; // Return true to avoid error popup for expected blocking
    }

    // Set both flags atomically
    isAnalysisInProgress = true;
    currentRequestId = requestId;
    lastAnalysisTime = now;
    currentPresetRestorationRequired = false;
    originalPresetName = null;

    try {
        const context = getContext();
        if (!context?.chat?.length) {
            console.warn(`${LOG_PREFIX_FUNC} No chat history available for analysis.`);
            toastr.warning("MoodMusic: No chat history available for mood analysis");
            return false; // Return false for genuine error condition
        }

        console.log(`${LOG_PREFIX_FUNC} Analyzing last ${HISTORY_FOR_MOOD_ANALYSIS} messages from chat...`);
        const history = context.chat.slice(-HISTORY_FOR_MOOD_ANALYSIS);

        // Filter out any potential duplicates and format properly
        const processedHistory = [];
        const seenMessages = new Set();

        for (const msg of history) {
            const messageKey = `${msg.is_user ? 'User' : 'Character'}:${msg.mes?.substring(0, 100)}`;
            if (!seenMessages.has(messageKey) && msg.mes?.trim()) {
                seenMessages.add(messageKey);
                processedHistory.push(msg);
            }
        }

        const chatHistorySnippet = processedHistory.map(msg =>
            `${msg.is_user ? 'User' : 'Character'}: ${msg.mes.trim()}`
        ).join('\n\n'); // Use double newlines for better separation

        console.log(`${LOG_PREFIX_FUNC} Chat snippet (${processedHistory.length} messages, ${chatHistorySnippet.length} characters):`);
        console.log(`${LOG_PREFIX_FUNC} History preview: ${chatHistorySnippet.substring(0, 300)}...`);

        originalPresetName = getCurrentPresetNameFromUi();
        if (!originalPresetName) {
            console.error(`${LOG_PREFIX_FUNC} Could not determine original preset name. Restoration may fail.`);
        } else {
            console.log(`${LOG_PREFIX_FUNC} Stored original preset: ${originalPresetName}`);
        }

        console.log(`${LOG_PREFIX_FUNC} Calling AI for music suggestion...`);
        const aiResponseText = await getMusicSuggestionFromAI(chatHistorySnippet);

        if (aiResponseText) {
            console.log(`${LOG_PREFIX_FUNC} AI responded, parsing suggestion...`);
            const suggestion = parseMusicFromAiResponse(aiResponseText);
            if (suggestion) {
                console.log(`${LOG_PREFIX_FUNC} Successfully parsed suggestion, requesting play:`, suggestion);
                await requestPlaySong(suggestion, true); // This is an original AI suggestion
                return true; // Success case
            } else {
                console.error(`${LOG_PREFIX_FUNC} Failed to parse music suggestion from AI response.`);
                toastr.error("MoodMusic: Could not understand the AI's music suggestion");
                return false;
            }
        } else {
            console.error(`${LOG_PREFIX_FUNC} Failed to get a valid suggestion from AI.`);
            toastr.error("MoodMusic: AI did not provide a music suggestion");
            return false;
        }
    } catch (error) {
        console.error(`${LOG_PREFIX_FUNC} UNEXPECTED ERROR in analysis sequence:`, error);
        toastr.error(`MoodMusic: Unexpected error - ${error.message}`);
        return false;
    } finally {
        await restoreOriginalPreset();
        isAnalysisInProgress = false;
        const finishedRequestId = currentRequestId;
        currentRequestId = null; // Release the request lock
        console.log(`${LOG_PREFIX} [triggerMoodAnalysisAndPlay-${finishedRequestId}] Mood analysis process finished and lock released.`);
    }
}

// Manual trigger function for the "Choose Song" button
async function manualTriggerMusicAnalysis() {
    console.log(`${LOG_PREFIX} Manual music analysis triggered by user`);

    if (!isExtensionActive) {
        toastr.info("MoodMusic: Extension is paused - use the Resume button in settings to enable");
        return;
    }

    if (!isAuthenticated) {
        toastr.error("MoodMusic: Please log in to Spotify first");
        return;
    }

    if (isAnalysisInProgress || currentRequestId !== null) {
        toastr.info("MoodMusic: Analysis already in progress, please wait");
        return;
    }

    // Add a slight delay to ensure UI responsiveness
    setTimeout(async () => {
        const success = await triggerMoodAnalysisAndPlay();
        if (!success) {
            toastr.warning("MoodMusic: Could not analyze mood at this time");
        }
    }, 100);
}

// Add the manual trigger button to the UI
function addManualTriggerButton() {
    // Remove existing button if it exists
    $('#moodmusic-manual-trigger').remove();

    // Create the button
    const button = $(`
        <div id="moodmusic-manual-trigger" class="menu_button" style="
            margin: 5px auto;
            display: block;
            width: fit-content;
            background-color: #1db954;
            color: white;
            border: none;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 13px;
            cursor: pointer;
        ">
            <i class="fa-solid fa-music"></i> Choose Song
        </div>
    `);

    // Add click handler
    button.on('click', manualTriggerMusicAnalysis);

    // Insert above the send form
    $('#send_form').prepend(button);

    console.log(`${LOG_PREFIX} Manual trigger button added to UI`);
}

// Unified handler for character messages and swipes
async function handleCharacterEvent(messageId, type, eventSourceType) {
    const currentTime = Date.now();

    // Prevent rapid-fire events (within 1 second)
    if (currentTime - lastEventTimestamp < 1000) {
        return;
    }

    // Prevent duplicate processing of the same message
    if (messageId === lastProcessedMessageId) {
        return;
    }

    // Check minimum interval since last analysis
    if (currentTime - lastAnalysisTime < MIN_ANALYSIS_INTERVAL_MS) {
        return;
    }

    // Check if we should trigger
    if (!isExtensionActive || !isAuthenticated || isAnalysisInProgress) {
        return;
    }

    lastEventTimestamp = currentTime;

    // Clear any pending timeout to prevent multiple triggers
    if (analysisTimeout) {
        clearTimeout(analysisTimeout);
        analysisTimeout = null;
    }

    // Add delay and ensure only one analysis runs
    analysisTimeout = setTimeout(async () => {
        analysisTimeout = null;
        const currentTimeAtTimeout = Date.now();
        const timeSinceLastAnalysis = currentTimeAtTimeout - lastAnalysisTime;

        if (!isAnalysisInProgress &&
            currentRequestId === null &&
            isExtensionActive &&
            isAuthenticated &&
            timeSinceLastAnalysis >= MIN_ANALYSIS_INTERVAL_MS) {

            lastProcessedMessageId = messageId;

            // Wait for AI system to be ready
            setTimeout(async () => {
                const context = getContext();
                if (context.generationInProgress) {
                    setTimeout(() => triggerMoodAnalysisAndPlay(), 3000);
                } else {
                    await triggerMoodAnalysisAndPlay();
                }
            }, 2000);
        } else {
            console.log(`${LOG_EVENT_PREFIX} Conditions not met at timeout, skipping`);
        }
    }, 3000); // Increased delay to allow main AI generation to fully complete
}

// Special handler for swipes that's more lenient than regular character events
async function handleSwipeEvent(messageId) {
    const LOG_EVENT_PREFIX = `${LOG_PREFIX} [AUTO-TRIGGER-SWIPE]`;
    const currentTime = Date.now();

    console.log(`${LOG_EVENT_PREFIX} Swipe event received for message ID: ${messageId}`);
    console.log(`${LOG_EVENT_PREFIX} State check - Active: ${isExtensionActive}, Auth: ${isAuthenticated}, InProgress: ${isAnalysisInProgress}`);

    // For swipes, we're more lenient - only check basic conditions
    if (!isExtensionActive || !isAuthenticated || isAnalysisInProgress) {
        return;
    }

    // For swipes, use a shorter minimum interval (1 second instead of 3)
    if (currentTime - lastAnalysisTime < 1000) {
        return;
    }

    // Clear any pending timeout to prevent multiple triggers
    if (analysisTimeout) {
        clearTimeout(analysisTimeout);
        analysisTimeout = null;
    }

    // Shorter delay for swipes since they're user-initiated
    analysisTimeout = setTimeout(async () => {
        analysisTimeout = null;

        if (!isAnalysisInProgress && currentRequestId === null && isExtensionActive && isAuthenticated) {
            lastProcessedMessageId = messageId;
            await triggerMoodAnalysisAndPlay();
        } else {
            console.log(`${LOG_EVENT_PREFIX} Swipe conditions not met at timeout, skipping`);
        }
    }, 800); // Shorter delay for swipes
}

function setupAutoTrigger() {
    const LOG_PREFIX_FUNC = `${LOG_PREFIX} [setupAutoTrigger]`;

    if (isAutoTriggerSetup) {
        console.log(`${LOG_PREFIX_FUNC} Auto-trigger already set up, skipping...`);
        return;
    }

    console.log(`${LOG_PREFIX_FUNC} Setting up automatic mood analysis on generation completion and swipes...`);

    // Handle when AI generation ends (including streaming completion)
    eventSource.makeLast(event_types.GENERATION_ENDED, async () => {
        // Get the latest message ID from chat
        const context = getContext();
        const chat = context.chat;
        if (chat && chat.length > 0) {
            const lastMessageId = chat.length - 1;
            const lastMessage = chat[lastMessageId];

            // Only trigger for character messages, not user messages
            if (lastMessage && !lastMessage.is_user) {
                await handleCharacterEvent(lastMessageId, 'generation_ended', 'GENERATION_ENDED');
            }
        }
    });

    // Handle when a message is swiped/regenerated
    eventSource.on(event_types.MESSAGE_SWIPED, async (messageId) => {
        await handleSwipeEvent(messageId);
    });

    isAutoTriggerSetup = true;
    console.log(`${LOG_PREFIX_FUNC} Auto-trigger setup complete. Extension will analyze mood when AI generation completes (including streaming) and on swipes.`);
}

function toggleExtensionActiveState() {
    isExtensionActive = !isExtensionActive;
    updateToggleButtonUI();
    if (isExtensionActive) {
        console.log(`${LOG_PREFIX} Extension Resumed.`);
        if (!pollingIntervalId && isAuthenticated) {
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
            pollPlaybackState();
        }
    } else {
        console.log(`${LOG_PREFIX} Extension Paused.`);
        stopPlaybackPolling();
        if (pollingIntervalId) { clearInterval(pollingIntervalId); pollingIntervalId = null; }
        if (isAnalysisInProgress) restoreOriginalPreset();
        isAnalysisInProgress = false;
    }
}

async function initializeExtension() {
    console.log(`${LOG_PREFIX} Initializing...`);
    if (isInitialized) return;

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
        $('#extensions_settings')
            .on('click', '#moodmusic-save-creds-button', saveSpotifyCredentials)
            .on('click', '#moodmusic-clear-creds-button', clearSpotifyCredentials)
            .on('click', '#moodmusic-login-button', triggerSpotifyLogin)
            .on('click', '#moodmusic-toggle-button', toggleExtensionActiveState)
            .on('click', '#moodmusic-switch-model-button', switchModelMode)
            .on('click', '#moodmusic-test-liked-button', testLikedSongs)
            .on('change', '#moodmusic-use-liked-fallback', saveLikedSongsSettings);

        updateToggleButtonUI();
        updateModelStatusUI();
        loadLikedSongsSettings();
        findAndStorePresetDropdown();

        // Set up automatic mood analysis when character responds
        setupAutoTrigger();

        // Add the manual trigger button
        addManualTriggerButton();

        await loadCredentialsStatus();
        await checkAuthStatus();

        if (isExtensionActive && isAuthenticated) {
            if (pollingIntervalId) clearInterval(pollingIntervalId);
            pollingIntervalId = setInterval(pollPlaybackState, POLLING_INTERVAL_MS);
        }
        isInitialized = true;
        console.log(`${LOG_PREFIX} Initialization COMPLETE.`);
    } catch (error) {
        console.error(`${LOG_PREFIX} Initialization FAILED:`, error);
        $("#extensions_settings").append(`<div class="error" style="color:red;"><b>MoodMusic INIT FAILED:</b> ${error.message}. Check Console.</div>`);
    }
}

$(document).ready(() => {
    setTimeout(initializeExtension, 1500);
});
