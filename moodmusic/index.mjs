// --- START OF FILE SillyTavern/plugins/moodmusic/index.mjs ---
import { Router } from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { jsonParser } from '../../src/express-common.js';

// --- Configuration ---
let SPOTIFY_CLIENT_ID = process.env.MOODMUSIC_SPOTIFY_CLIENT_ID || null;
let SPOTIFY_CLIENT_SECRET = process.env.MOODMUSIC_SPOTIFY_CLIENT_SECRET || null;

// Credentials persistence
const CREDENTIALS_FILE = path.join(process.cwd(), 'plugins', 'moodmusic', 'credentials.json');

function loadSavedCredentials() {
    try {
        if (fs.existsSync(CREDENTIALS_FILE)) {
            const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
            if (data.clientId && data.clientSecret) {
                SPOTIFY_CLIENT_ID = data.clientId;
                SPOTIFY_CLIENT_SECRET = data.clientSecret;
                console.log('[Spotify Music Plugin] Loaded saved credentials from file.');
            }
        }
    } catch (error) {
        console.warn('[Spotify Music Plugin] Error loading saved credentials:', error.message);
    }
}

function saveCredentials() {
    try {
        const data = {
            clientId: SPOTIFY_CLIENT_ID,
            clientSecret: SPOTIFY_CLIENT_SECRET
        };
        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log('[Spotify Music Plugin] Credentials saved to file.');
    } catch (error) {
        console.error('[Spotify Music Plugin] Error saving credentials:', error.message);
    }
}

// The redirect URI must exactly match the one in your Spotify Developer Dashboard
const getRedirectUri = (req) => {
    const host = req.get('host'); // e.g., 'localhost:8000' or '127.0.0.1:8000'
    const protocol = req.protocol; // http or https
    return `${protocol}://${host}/api/plugins/moodmusic/auth/callback`;
};


// --- State (In-memory storage) ---
let accessToken = null;
let refreshToken = null;
let tokenExpiryTime = null; // Timestamp (ms) when accessToken expires

// --- Spotify API URLs & Scopes ---
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read';

const LOG_PREFIX_PLUGIN = '[Spotify Music Plugin]';

// --- Helper Functions ---

function areCredentialsConfigured() {
    return SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET;
}

// OPTIMIZED: Helper to send a simple HTML response to the user's popup window
function sendHtmlResponse(res, title, message, isSuccess = true) {
    const color = isSuccess ? '#4CAF50' : '#F44336';
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>${title}</title>
            <style>
                body { font-family: sans-serif; background-color: #252525; color: #f1f1f1; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { text-align: center; padding: 2em; border: 1px solid #444; border-radius: 8px; background-color: #333; }
                h1 { color: ${color}; }
                button { background-color: #555; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 1em; }
                button:hover { background-color: #666; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>${isSuccess ? 'Success!' : 'Error'}</h1>
                <p>${message}</p>
                <button onclick="window.close()">Close this window</button>
            </div>
            <script>
                // For successful auth, we can also add an alert.
                if (${isSuccess}) {
                    alert("Spotify Login Successful! You can now close this tab.");
                }
                // Automatically close the window after a few seconds for convenience
                // setTimeout(() => window.close(), 3000);
            </script>
        </body>
        </html>`;
    res.send(html);
}


async function getValidAccessToken() {
    const LOG_PREFIX_TOKEN = `${LOG_PREFIX_PLUGIN} [TokenHelper]`;

    if (!areCredentialsConfigured()) {
        throw new Error('Spotify Client ID or Secret not configured on the server.');
    }

    // Return current token if it's still valid (with a 60-second buffer)
    if (accessToken && tokenExpiryTime && Date.now() < tokenExpiryTime - 60000) {
        return accessToken;
    }

    if (!refreshToken) {
        console.error(`${LOG_PREFIX_TOKEN} No refresh token available. User needs to re-authenticate.`);
        return null; // Signals to the caller that re-authentication is needed
    }

    console.log(`${LOG_PREFIX_TOKEN} Access token expired or missing. Attempting refresh...`);
    try {
        const authHeader = 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
        const response = await axios.post(SPOTIFY_TOKEN_URL, new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }), {
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        accessToken = response.data.access_token;
        tokenExpiryTime = Date.now() + (response.data.expires_in * 1000);
        // Spotify may optionally issue a new refresh token
        if (response.data.refresh_token) {
            refreshToken = response.data.refresh_token;
            console.log(`${LOG_PREFIX_TOKEN} Received a NEW refresh token.`);
        }
        console.log(`${LOG_PREFIX_TOKEN} Token refreshed successfully.`);
        return accessToken;

    } catch (error) {
        console.error(`${LOG_PREFIX_TOKEN} Error refreshing access token:`, error.response ? error.response.data : error.message);
        // If refresh fails, clear all tokens to force a new login
        accessToken = null;
        refreshToken = null;
        tokenExpiryTime = null;
        return null;
    }
}

export async function init(router) {
    const LOG_PREFIX_INIT = `${LOG_PREFIX_PLUGIN} [Init]`;
    console.log(`${LOG_PREFIX_INIT} Initializing Spotify Music server plugin...`);

    // Load saved credentials on startup
    loadSavedCredentials();

    // === Configuration Endpoint (/config) ===
    router.post('/config', jsonParser, (req, res) => {
        const { clientId, clientSecret } = req.body;
        if (!clientId || typeof clientId !== 'string' || !clientSecret || typeof clientSecret !== 'string') {
            return res.status(400).json({ success: false, message: 'Client ID and Client Secret are required.' });
        }
        SPOTIFY_CLIENT_ID = clientId.trim();
        SPOTIFY_CLIENT_SECRET = clientSecret.trim();

        // Save credentials to file for persistence
        saveCredentials();

        // Invalidate existing tokens, as they are tied to the old credentials
        accessToken = null;
        refreshToken = null;
        tokenExpiryTime = null;
        console.log(`${LOG_PREFIX_PLUGIN} [/config] Credentials updated and saved. Existing tokens cleared.`);
        res.json({ success: true, message: 'Spotify credentials updated and saved successfully.' });
    });

    router.get('/config', (req, res) => {
        const maskString = (str) => {
            if (!str) return '';
            if (str.length <= 8) return '*'.repeat(str.length);
            return str.substring(0, 4) + '*'.repeat(str.length - 8) + str.substring(str.length - 4);
        };

        res.json({
            clientIdSet: !!SPOTIFY_CLIENT_ID,
            clientSecretSet: !!SPOTIFY_CLIENT_SECRET,
            clientId: SPOTIFY_CLIENT_ID ? maskString(SPOTIFY_CLIENT_ID) : '',
            clientSecret: SPOTIFY_CLIENT_SECRET ? maskString(SPOTIFY_CLIENT_SECRET) : ''
        });
    });

    router.delete('/config', (req, res) => {
        SPOTIFY_CLIENT_ID = null;
        SPOTIFY_CLIENT_SECRET = null;

        // Delete the credentials file
        try {
            if (fs.existsSync(CREDENTIALS_FILE)) {
                fs.unlinkSync(CREDENTIALS_FILE);
                console.log(`${LOG_PREFIX_PLUGIN} [/config DELETE] Credentials file deleted.`);
            }
        } catch (error) {
            console.warn(`${LOG_PREFIX_PLUGIN} [/config DELETE] Error deleting credentials file:`, error.message);
        }

        // Clear tokens
        accessToken = null;
        refreshToken = null;
        tokenExpiryTime = null;

        console.log(`${LOG_PREFIX_PLUGIN} [/config DELETE] Credentials cleared.`);
        res.json({ success: true, message: 'Spotify credentials cleared successfully.' });
    });

    // === Authentication Start (/auth/login) ===
    router.get('/auth/login', (req, res) => {
        if (!areCredentialsConfigured() || !SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
            console.error(`${LOG_PREFIX_PLUGIN} [/auth/login] Attempted login before credentials were set.`);
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
        console.log(`${LOG_PREFIX_PLUGIN} [/auth/login] Redirecting user to Spotify for authentication.`);
        res.redirect(authUrl.toString());
    });

    // === Authentication Callback (/auth/callback) ===
    router.get('/auth/callback', async (req, res) => {
        const { code, error } = req.query;
        if (error) {
            console.error(`${LOG_PREFIX_PLUGIN} [/auth/callback] Spotify returned an error: ${error}`);
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
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            accessToken = tokenResponse.data.access_token;
            refreshToken = tokenResponse.data.refresh_token;
            tokenExpiryTime = Date.now() + (tokenResponse.data.expires_in * 1000);
            console.log(`${LOG_PREFIX_PLUGIN} [/auth/callback] Authorization successful. Tokens obtained.`);
            sendHtmlResponse(res, 'Login Successful', 'You can now close this window.');

        } catch (err) {
            console.error(`${LOG_PREFIX_PLUGIN} [/auth/callback] Error exchanging code for tokens:`, err.response ? err.response.data : err.message);
            sendHtmlResponse(res, 'Spotify Login Error', 'Failed to exchange authorization code for tokens. Check server logs.', false);
        }
    });

    // === Authentication Status (/auth/status) ===
    router.get('/auth/status', (req, res) => {
        res.json({
            loggedIn: !!refreshToken, // The presence of a refresh token is the true indicator of a persistent login
            credentialsSet: areCredentialsConfigured(),
        });
    });

    // Middleware to protect subsequent routes
    const requireAuth = async (req, res, next) => {
        if (!areCredentialsConfigured()) {
            return res.status(400).json({ error: 'Spotify credentials not configured.', needsConfiguration: true });
        }
        const token = await getValidAccessToken();
        if (!token) {
            return res.status(401).json({ error: 'Authentication required.', needsLogin: true });
        }
        req.accessToken = token; // Attach token for use in next handlers
        next();
    };


    // === Get Playback State (/playback/state) ===
    router.get('/playback/state', requireAuth, async (req, res) => {
        try {
            const stateResponse = await axios.get(`${SPOTIFY_API_BASE}/me/player`, {
                headers: { 'Authorization': `Bearer ${req.accessToken}` },
            });
            // 204 No Content means no active player
            if (stateResponse.status === 204 || !stateResponse.data) {
                return res.json({ is_playing: false, item: null });
            }
            res.json(stateResponse.data);
        } catch (error) {
            console.error(`${LOG_PREFIX_PLUGIN} [/playback/state] Error fetching playback state:`, error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Could not fetch playback state.' });
        }
    });


    // === Play Endpoint (/play) ===
    router.post('/play', jsonParser, requireAuth, async (req, res) => {
        const { suggestion } = req.body;
        if (!suggestion?.title) {
            return res.status(400).json({ success: false, message: 'Invalid song suggestion format.' });
        }

        try {
            // 1. Search for the track with multiple strategies
            let track = null;
            const title = suggestion.title.trim();
            const artist = suggestion.artist?.trim();

            // Strategy 1: Exact search with full artist string
            if (artist) {
                const exactQuery = `track:"${title}" artist:"${artist}"`;
                console.log(`${LOG_PREFIX_PLUGIN} [/play] Trying exact search: ${exactQuery}`);

                const exactResponse = await axios.get(`${SPOTIFY_API_BASE}/search`, {
                    headers: { 'Authorization': `Bearer ${req.accessToken}` },
                    params: { q: exactQuery, type: 'track', limit: 1 }
                });
                track = exactResponse.data?.tracks?.items?.[0];
            }

            // Strategy 2: If no match and artist has comma/multiple artists, try with first artist only
            if (!track && artist && (artist.includes(',') || artist.includes('&') || artist.includes(' feat'))) {
                const firstArtist = artist.split(/[,&]|feat\.?/i)[0].trim();
                const firstArtistQuery = `track:"${title}" artist:"${firstArtist}"`;
                console.log(`${LOG_PREFIX_PLUGIN} [/play] Trying first artist search: ${firstArtistQuery}`);

                const firstArtistResponse = await axios.get(`${SPOTIFY_API_BASE}/search`, {
                    headers: { 'Authorization': `Bearer ${req.accessToken}` },
                    params: { q: firstArtistQuery, type: 'track', limit: 1 }
                });
                track = firstArtistResponse.data?.tracks?.items?.[0];
            }

            // Strategy 3: Broader search with title + artist (no quotes, less strict)
            if (!track && artist) {
                const broadQuery = `track:${title} artist:${artist}`;
                console.log(`${LOG_PREFIX_PLUGIN} [/play] Trying broad search: ${broadQuery}`);

                const broadResponse = await axios.get(`${SPOTIFY_API_BASE}/search`, {
                    headers: { 'Authorization': `Bearer ${req.accessToken}` },
                    params: { q: broadQuery, type: 'track', limit: 5 }
                });

                // Find best match by checking if title matches closely
                const candidates = broadResponse.data?.tracks?.items || [];
                track = candidates.find(t =>
                    t.name.toLowerCase().includes(title.toLowerCase()) ||
                    title.toLowerCase().includes(t.name.toLowerCase())
                );
            }

            // Strategy 4: Title-only search as last resort
            if (!track) {
                const titleOnlyQuery = `track:"${title}"`;
                console.log(`${LOG_PREFIX_PLUGIN} [/play] Trying title-only search: ${titleOnlyQuery}`);

                const titleResponse = await axios.get(`${SPOTIFY_API_BASE}/search`, {
                    headers: { 'Authorization': `Bearer ${req.accessToken}` },
                    params: { q: titleOnlyQuery, type: 'track', limit: 10 }
                });

                // Find best match by checking title similarity and optionally artist match
                const candidates = titleResponse.data?.tracks?.items || [];
                if (artist) {
                    // Prefer tracks where at least one artist name is mentioned
                    track = candidates.find(t => {
                        const trackArtists = t.artists.map(a => a.name.toLowerCase()).join(' ');
                        const searchArtists = artist.toLowerCase().split(/[,&]|feat\.?/i);
                        return searchArtists.some(searchArtist =>
                            trackArtists.includes(searchArtist.trim())
                        );
                    });
                }
                // If still no match, just take the first result
                if (!track && candidates.length > 0) {
                    track = candidates[0];
                }
            }

            if (!track) {
                console.log(`${LOG_PREFIX_PLUGIN} [/play] No track found after all search strategies`);
                return res.status(404).json({ success: false, message: `Song "${title}" by ${artist || 'Unknown Artist'} not found.` });
            }

            console.log(`${LOG_PREFIX_PLUGIN} [/play] Found track: "${track.name}" by ${track.artists.map(a => a.name).join(', ')}`);

            // 2. Find an active device
            const devicesResponse = await axios.get(`${SPOTIFY_API_BASE}/me/player/devices`, {
                headers: { 'Authorization': `Bearer ${req.accessToken}` }
            });

            const activeDevice = devicesResponse.data?.devices?.find(d => d.is_active);
            const deviceId = activeDevice?.id;
            if (!deviceId) {
                console.warn(`${LOG_PREFIX_PLUGIN} [/play] No active Spotify device found. Available devices:`, devicesResponse.data?.devices);
                return res.status(404).json({ success: false, message: 'No active Spotify device found. Please start playing on a device first.' });
            }

            // 3. Send the play command
            await axios.put(`${SPOTIFY_API_BASE}/me/player/play`,
                { uris: [track.uri] },
                { headers: { 'Authorization': `Bearer ${req.accessToken}` }, params: { device_id: deviceId } }
            );

            const trackName = `${track.name} by ${track.artists.map(a => a.name).join(', ')}`;
            console.log(`${LOG_PREFIX_PLUGIN} [/play] Play command sent for "${trackName}" to device ${activeDevice.name}.`);
            res.json({ success: true, message: `Playing "${trackName}"`, trackUri: track.uri });

        } catch (error) {
            console.error(`${LOG_PREFIX_PLUGIN} [/play] Error during playback sequence:`, error.response ? error.response.data : error.message);
            const spotifyError = error.response?.data?.error;
            if (spotifyError) {
                return res.status(error.response.status).json({ success: false, message: `Spotify Error: ${spotifyError.message}` });
            }
            res.status(500).json({ success: false, message: 'An internal server error occurred.' });
        }
    });

    // === Play Liked Songs (/play/liked) ===
    router.post('/play/liked', requireAuth, async (req, res) => {
        try {
            // 1. Get user's liked songs
            const likedResponse = await axios.get(`${SPOTIFY_API_BASE}/me/tracks`, {
                headers: { 'Authorization': `Bearer ${req.accessToken}` },
                params: { limit: 50 } // Get up to 50 liked songs
            });

            const likedTracks = likedResponse.data?.items;
            if (!likedTracks || likedTracks.length === 0) {
                return res.status(404).json({ success: false, message: 'No liked songs found. Please like some songs on Spotify first.' });
            }

            // 2. Find an active device
            const devicesResponse = await axios.get(`${SPOTIFY_API_BASE}/me/player/devices`, {
                headers: { 'Authorization': `Bearer ${req.accessToken}` }
            });

            const activeDevice = devicesResponse.data?.devices?.find(d => d.is_active);
            const deviceId = activeDevice?.id;
            if (!deviceId) {
                console.warn(`${LOG_PREFIX_PLUGIN} [/play/liked] No active Spotify device found. Available devices:`, devicesResponse.data?.devices);
                return res.status(404).json({ success: false, message: 'No active Spotify device found. Please start playing on a device first.' });
            }

            // 3. Try to play the "Liked Songs" collection context first
            try {
                await axios.put(`${SPOTIFY_API_BASE}/me/player/play`,
                    { context_uri: 'spotify:collection:tracks' }, // Standard Liked Songs URI
                    { headers: { 'Authorization': `Bearer ${req.accessToken}` }, params: { device_id: deviceId } }
                );
            } catch (contextError) {
                // Fallback: play individual tracks if context doesn't work
                console.log(`${LOG_PREFIX_PLUGIN} [/play/liked] Context play failed, using individual tracks:`, contextError.response?.data?.error?.message);

                const trackUris = likedTracks.slice(0, 50).map(item => item.track.uri);
                await axios.put(`${SPOTIFY_API_BASE}/me/player/play`,
                    { uris: trackUris },
                    { headers: { 'Authorization': `Bearer ${req.accessToken}` }, params: { device_id: deviceId } }
                );
            }

            // Enable shuffle for variety
            await axios.put(`${SPOTIFY_API_BASE}/me/player/shuffle`,
                null,
                {
                    headers: { 'Authorization': `Bearer ${req.accessToken}` },
                    params: { state: 'true', device_id: deviceId }
                }
            );

            console.log(`${LOG_PREFIX_PLUGIN} [/play/liked] Started playing liked songs (${likedTracks.length} available) on device ${activeDevice.name}.`);
            res.json({
                success: true,
                message: `Playing your liked songs (${likedTracks.length} songs available)`,
                trackCount: likedTracks.length
            });

        } catch (error) {
            console.error(`${LOG_PREFIX_PLUGIN} [/play/liked] Error playing liked songs:`, error.response ? error.response.data : error.message);

            // Fallback: try playing individual tracks if context fails
            if (error.response?.status === 403 || error.response?.data?.error?.reason === 'PREMIUM_REQUIRED') {
                try {
                    const likedResponse = await axios.get(`${SPOTIFY_API_BASE}/me/tracks`, {
                        headers: { 'Authorization': `Bearer ${req.accessToken}` },
                        params: { limit: 20 }
                    });

                    const tracks = likedResponse.data?.items;
                    if (tracks && tracks.length > 0) {
                        // Pick a random liked song
                        const randomTrack = tracks[Math.floor(Math.random() * tracks.length)].track;

                        await axios.put(`${SPOTIFY_API_BASE}/me/player/play`,
                            { uris: [randomTrack.uri] },
                            { headers: { 'Authorization': `Bearer ${req.accessToken}` }, params: { device_id: await getActiveDeviceId(req.accessToken) } }
                        );

                        const trackName = `${randomTrack.name} by ${randomTrack.artists.map(a => a.name).join(', ')}`;
                        console.log(`${LOG_PREFIX_PLUGIN} [/play/liked] Fallback: Playing random liked song "${trackName}".`);
                        return res.json({ success: true, message: `Playing random liked song: "${trackName}"`, trackUri: randomTrack.uri });
                    }
                } catch (fallbackError) {
                    console.error(`${LOG_PREFIX_PLUGIN} [/play/liked] Fallback also failed:`, fallbackError.message);
                }
            }

            const spotifyError = error.response?.data?.error;
            if (spotifyError) {
                return res.status(error.response.status).json({ success: false, message: `Spotify Error: ${spotifyError.message}` });
            }
            res.status(500).json({ success: false, message: 'Failed to play liked songs.' });
        }
    });

    // Helper function to get active device ID
    async function getActiveDeviceId(accessToken) {
        try {
            const devicesResponse = await axios.get(`${SPOTIFY_API_BASE}/me/player/devices`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            return devicesResponse.data?.devices?.find(d => d.is_active)?.id;
        } catch (error) {
            console.error(`${LOG_PREFIX_PLUGIN} [getActiveDeviceId] Error:`, error.message);
            return null;
        }
    }

    console.log(`${LOG_PREFIX_INIT} Spotify Music plugin routes initialized successfully.`);
}

export async function exit() {
    console.log(`${LOG_PREFIX_PLUGIN} Exiting server plugin.`);
}

const moodMusicModule = {
    init, exit,
    info: { id: 'moodmusic', name: 'Spotify Music', description: 'Plays Spotify music based on chat mood analysis.' },
};
export default moodMusicModule;
