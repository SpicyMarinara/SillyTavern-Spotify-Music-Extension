import { Router } from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { jsonParser } from '../../src/express-common.js';

// Configuration
let SPOTIFY_CLIENT_ID = process.env.SPOTIFY_MUSIC_CLIENT_ID || null;
let SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_MUSIC_CLIENT_SECRET || null;

// Spotify API constants
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private user-library-read';

// OAuth state management
let accessToken = null;
let refreshToken = null;
let tokenExpiryTime = null;

const CREDENTIALS_FILE = path.join(process.cwd(), 'plugins', 'spotify-music', 'credentials.json');

function loadSavedCredentials() {
    try {
        if (fs.existsSync(CREDENTIALS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
            if (data.clientId && data.clientSecret) {
                SPOTIFY_CLIENT_ID = data.clientId;
                SPOTIFY_CLIENT_SECRET = data.clientSecret;
                console.log('[Spotify Music] Loaded saved credentials from file.');
            }
        }
    } catch (error) {
        console.warn('[Spotify Music] Error loading saved credentials:', error.message);
    }
}

function saveCredentials() {
    try {
        const dir = path.dirname(CREDENTIALS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const data = {
            clientId: SPOTIFY_CLIENT_ID,
            clientSecret: SPOTIFY_CLIENT_SECRET
        };
        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2));
        console.log('[Spotify Music] Credentials saved to file.');
    } catch (error) {
        console.warn('[Spotify Music] Error saving credentials:', error.message);
    }
}

// Load credentials on startup
loadSavedCredentials();

console.log('[Spotify Music] Plugin loaded successfully');

// SillyTavern plugin interface
export const info = {
    id: 'spotify-music',
    name: 'Spotify Music',
    description: 'Plays Spotify music based on chat mood analysis.'
};

export async function init(pluginRouter) {
    // Load saved credentials on startup
    loadSavedCredentials();

    // Move all our routes to the plugin router
    pluginRouter.post('/config', jsonParser, (req, res) => {
        console.log('[Spotify Music] Config POST endpoint called');
        const { clientId, clientSecret } = req.body;

        if (!clientId || !clientSecret) {
            return res.status(400).json({ success: false, message: 'Client ID and Client Secret are required.' });
        }

        SPOTIFY_CLIENT_ID = clientId.trim();
        SPOTIFY_CLIENT_SECRET = clientSecret.trim();
        saveCredentials();

        console.log('[Spotify Music] Credentials updated and saved.');
        res.json({ success: true, message: 'Spotify credentials updated successfully.' });
    });

    pluginRouter.get('/config', (req, res) => {
        console.log('[Spotify Music] Config GET endpoint called');
        res.json({
            clientIdSet: !!SPOTIFY_CLIENT_ID,
            clientSecretSet: !!SPOTIFY_CLIENT_SECRET,
            clientId: SPOTIFY_CLIENT_ID ? SPOTIFY_CLIENT_ID.substring(0, 8) + '...' : '',
            clientSecret: SPOTIFY_CLIENT_SECRET ? SPOTIFY_CLIENT_SECRET.substring(0, 8) + '...' : ''
        });
    });

    // === Authentication Endpoints ===

    // Helper function to get redirect URI - dynamically detects port from request
    function getRedirectUri(req) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const host = req.headers['x-forwarded-host'] || req.headers.host || req.get('host');
        return `${protocol}://${host}/api/plugins/spotify-music/auth/callback`;
    }

    // Helper function to send HTML response
    function sendHtmlResponse(res, title, message, isSuccess = true) {
        const color = isSuccess ? '#28a745' : '#dc3545';
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>${title}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; text-align: center; }
        h1 { color: ${color}; }
        p { margin: 20px 0; }
        .container { max-width: 600px; margin: 0 auto; }
    </style>
</head>
<body>
    <div class="container">
        <h1>${title}</h1>
        <p>${message}</p>
        <p>You can close this window and return to SillyTavern.</p>
    </div>
</body>
</html>`;
        res.send(html);
    }

    pluginRouter.get('/auth/login', (req, res) => {
        if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
            console.error('[Spotify Music] Attempted login before credentials were set.');
            return sendHtmlResponse(res, 'Configuration Error', 'Spotify Client ID or Secret not configured on the server.', false);
        }

        const redirectUri = getRedirectUri(req);
        const authUrl = new URL(SPOTIFY_AUTH_URL);
        authUrl.search = new URLSearchParams({
            response_type: 'code',
            client_id: SPOTIFY_CLIENT_ID,
            scope: SCOPES,
            redirect_uri: redirectUri,
        }).toString();

        console.log('[Spotify Music] Redirecting user to Spotify for authentication.');
        res.redirect(authUrl.toString());
    });

    pluginRouter.get('/auth/callback', async (req, res) => {
        const { code, error } = req.query;

        if (error) {
            console.error('[Spotify Music] Spotify returned an error:', error);
            return sendHtmlResponse(res, 'Spotify Login Error', `An error occurred: <strong>${error}</strong>`, false);
        }

        if (!code) {
            return sendHtmlResponse(res, 'Spotify Login Error', 'No authorization code received from Spotify.', false);
        }

        try {
            const redirectUri = getRedirectUri(req);
            const authHeader = 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');

            const tokenResponse = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
            }), {
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            accessToken = tokenResponse.data.access_token;
            refreshToken = tokenResponse.data.refresh_token;
            tokenExpiryTime = Date.now() + (tokenResponse.data.expires_in * 1000);

            console.log('[Spotify Music] Authorization successful. Tokens obtained.');
            sendHtmlResponse(res, 'Login Successful', 'Successfully logged in to Spotify! You can now close this window.');

        } catch (err) {
            console.error('[Spotify Music] Error exchanging code for tokens:', err.response ? err.response.data : err.message);
            sendHtmlResponse(res, 'Spotify Login Error', 'Failed to exchange authorization code for tokens. Check server logs.', false);
        }
    });

    pluginRouter.get('/auth/status', (req, res) => {
        res.json({
            loggedIn: !!refreshToken,
            credentialsSet: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET),
        });
    });

    // === Spotify API Endpoints ===

    // Helper function to check if token is expired and needs refresh
    async function ensureValidToken() {
        if (!accessToken || !refreshToken) {
            throw new Error('Not authenticated');
        }

        // Check if token is expired (with 5 minute buffer)
        if (tokenExpiryTime && Date.now() > (tokenExpiryTime - 300000)) {
            console.log('[Spotify Music] Access token expired, refreshing...');

            const authHeader = 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
            const response = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }), {
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            accessToken = response.data.access_token;
            tokenExpiryTime = Date.now() + (response.data.expires_in * 1000);

            // Update refresh token if provided
            if (response.data.refresh_token) {
                refreshToken = response.data.refresh_token;
            }

            console.log('[Spotify Music] Token refreshed successfully');
        }

        return accessToken;
    }

    // Helper function to make authenticated Spotify API calls
    async function spotifyApiCall(method, endpoint, data) {
        const token = await ensureValidToken();

        const config = {
            method,
            url: `${SPOTIFY_API_BASE}${endpoint}`,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        };

        if (data !== undefined && data !== null) {
            config.data = data;
        }

        return await axios(config);
    }

    // Play user's liked songs
    pluginRouter.post('/play/liked', async (req, res) => {
        try {
            if (!accessToken || !refreshToken) {
                return res.status(401).json({
                    success: false,
                    message: 'Not authenticated with Spotify',
                    needsLogin: true
                });
            }

            // Get user's liked songs
            const likedResponse = await spotifyApiCall('GET', '/me/tracks?limit=50');
            const likedTracks = likedResponse.data.items;

            if (likedTracks.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No liked songs found. Please like some songs on Spotify first.'
                });
            }

            // Get active device
            const devicesResponse = await spotifyApiCall('GET', '/me/player/devices');
            const activeDevice = devicesResponse.data.devices.find(device => device.is_active);

            if (!activeDevice) {
                return res.status(400).json({
                    success: false,
                    message: 'No active Spotify device found. Please open Spotify on a device first.'
                });
            }

            // Try to play the "Liked Songs" collection context first (most natural)
            try {
                await spotifyApiCall('PUT', `/me/player/play?device_id=${activeDevice.id}`, {
                    context_uri: 'spotify:collection:tracks' // Standard Liked Songs URI
                });

                console.log('[Spotify Music] Started playing liked songs collection');
                return res.json({
                    success: true,
                    message: `Playing your liked songs (${likedTracks.length} songs available)`,
                    device: activeDevice.name
                });

            } catch (contextError) {
                // Fallback: play individual tracks from liked songs
                console.log('[Spotify Music] Collection context failed, using track URIs fallback');

                const trackUris = likedTracks.map(item => item.track.uri);
                await spotifyApiCall('PUT', `/me/player/play?device_id=${activeDevice.id}`, {
                    uris: trackUris.slice(0, 20) // Limit to first 20 tracks to avoid oversized requests
                });

                console.log('[Spotify Music] Started playing liked songs via track URIs');
                return res.json({
                    success: true,
                    message: `Playing your liked songs (${Math.min(trackUris.length, 20)} of ${likedTracks.length} songs)`,
                    device: activeDevice.name
                });
            }

        } catch (error) {
            console.error('[Spotify Music] Error playing liked songs:', error.response ? error.response.data : error.message);

            if (error.response?.status === 401) {
                return res.status(401).json({
                    success: false,
                    message: 'Spotify authentication expired',
                    needsLogin: true
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Failed to play liked songs. Check server logs for details.'
            });
        }
    });

    // Search and play a specific song
    pluginRouter.post('/play', jsonParser, async (req, res) => {
        try {
            if (!accessToken || !refreshToken) {
                return res.status(401).json({
                    success: false,
                    message: 'Not authenticated with Spotify',
                    needsLogin: true
                });
            }

            const { suggestion } = req.body;
            if (!suggestion || !suggestion.title || !suggestion.artist) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid request. Need suggestion with title and artist.'
                });
            }

            // Search for the song
            const searchQuery = `${suggestion.title} ${suggestion.artist}`.trim();
            const searchResponse = await spotifyApiCall('GET', `/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=5`);

            if (!searchResponse.data.tracks || searchResponse.data.tracks.items.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: `No tracks found for "${suggestion.artist} - ${suggestion.title}"`
                });
            }

            const track = searchResponse.data.tracks.items[0];
            console.log(`[Spotify Music] Found track: ${track.artists[0].name} - ${track.name}`);

            // Get active device
            const devicesResponse = await spotifyApiCall('GET', '/me/player/devices');
            const activeDevice = devicesResponse.data.devices.find(device => device.is_active);

            if (!activeDevice) {
                return res.status(400).json({
                    success: false,
                    message: 'No active Spotify device found. Please open Spotify on a device first.'
                });
            }

            // Play the track
            await spotifyApiCall('PUT', `/me/player/play?device_id=${activeDevice.id}`, {
                uris: [track.uri]
            });

            console.log(`[Spotify Music] Started playing: ${track.artists[0].name} - ${track.name} on ${activeDevice.name}`);

            return res.json({
                success: true,
                message: `Now playing: ${track.artists[0].name} - ${track.name}`,
                track: {
                    name: track.name,
                    artist: track.artists[0].name,
                    uri: track.uri,
                    external_url: track.external_urls.spotify
                },
                device: activeDevice.name
            });

        } catch (error) {
            console.error('[Spotify Music] Error playing song:', error.response ? error.response.data : error.message);

            if (error.response?.status === 401) {
                return res.status(401).json({
                    success: false,
                    message: 'Spotify authentication expired',
                    needsLogin: true
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Failed to play song. Check server logs for details.'
            });
        }
    });

    // Get current playback state
    pluginRouter.get('/playback/state', async (req, res) => {
        try {
            if (!accessToken || !refreshToken) {
                return res.status(401).json({
                    success: false,
                    message: 'Not authenticated with Spotify',
                    needsLogin: true
                });
            }

            const playbackResponse = await spotifyApiCall('GET', '/me/player');

            // Spotify returns 204 when no content (no active playback)
            if (playbackResponse.status === 204 || !playbackResponse.data) {
                return res.json({
                    success: true,
                    is_playing: false,
                    message: 'No active playback'
                });
            }

            const playback = playbackResponse.data;
            return res.json({
                success: true,
                is_playing: playback.is_playing,
                track: playback.item ? {
                    name: playback.item.name,
                    artist: playback.item.artists[0]?.name,
                    uri: playback.item.uri,
                    duration_ms: playback.item.duration_ms,
                    external_url: playback.item.external_urls?.spotify
                } : null,
                device: playback.device ? {
                    name: playback.device.name,
                    type: playback.device.type,
                    volume_percent: playback.device.volume_percent
                } : null,
                progress_ms: playback.progress_ms,
                shuffle_state: playback.shuffle_state,
                repeat_state: playback.repeat_state
            });

        } catch (error) {
            console.error('[Spotify Music] Error getting playback state:', error.response ? error.response.data : error.message);

            if (error.response?.status === 401) {
                return res.status(401).json({
                    success: false,
                    message: 'Spotify authentication expired',
                    needsLogin: true
                });
            }

            // Handle 204 responses (no active playback) from Spotify
            if (error.response?.status === 204) {
                return res.json({
                    success: true,
                    is_playing: false,
                    message: 'No active playback'
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Failed to get playback state. Check server logs for details.'
            });
        }
    });

    // Test endpoint
    pluginRouter.get('/test', (req, res) => {
        res.json({ message: 'Spotify Music plugin is working!', timestamp: new Date().toISOString() });
    });

    console.log('[Spotify Music] Plugin routes initialized successfully');
}
