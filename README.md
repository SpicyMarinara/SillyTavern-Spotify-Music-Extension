# SillyTavern Spotify Music Extension

![gif](https://i.imgur.com/1bWVr7F.gif)

An intelligent Spotify integration extension for SillyTavern that automatically plays music based on chat mood analysis using AI.

## Features

- **🤖 Automatic Mood Analysis**: AI analyzes character messages and conversation mood to suggest appropriate music
- **🔄 Model Switching**: Choose between dedicated Music.json preset or your current AI model for suggestions
- **🎵 Intelligent Fallback System**: Falls back to your Spotify Liked Songs when AI suggestions fail
- **🔍 Advanced Search Algorithm**: Multi-tier search strategy for improved song discovery success rates
- **🎯 Manual Controls**: Test and trigger music manually when needed
- **🔐 Secure Authentication**: OAuth-based Spotify integration with encrypted credential storage

## Version 3.0 Enhancements

- Complete automatic triggering system
- Smart model switching between Music preset and current model
- Dynamic Liked Songs fallback system (replaces static fallback)
- Multi-strategy search algorithm for better song matching
- Enhanced error handling and user feedback
- Improved UI with better status indicators
- Full CSRF token integration for security

## Installation

### Prerequisites
1. **Spotify Premium Account** (required for playback control)
2. **Spotify Developer App**: Create one at [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
3. **SillyTavern** with plugin support enabled
4. **Server Plugins Enabled**: Set `enableServerPlugins: true` in your SillyTavern `config.yaml`

![png](https://i.imgur.com/rmySG4N.png)

### Setup Steps

#### 📥 **Step 1: Download the Extension Files**
1. **Download ZIP**: Click the green "Code" button at the top of this GitHub page → "Download ZIP"

![Download ZIP Screenshot](https://i.imgur.com/n6qhpwv.png)

2. **Extract ZIP**: Unzip the downloaded file on your computer
3. **Install Extension**: Copy the `SillyTavern-Spotify-Music-Extension/` folder from the ZIP to:
   ```
   SillyTavern/data/default-user/extensions/SillyTavern-Spotify-Music-Extension/
   ```
   *(The folder is already properly named - just copy it directly)*

#### 🔧 **Step 2: Install Server Plugin** 
1. **Install Plugin**: Copy the `spotify-music/` folder from the ZIP to:
   ```
   SillyTavern/plugins/spotify-music/
   ```
2. **Enable Plugins**: Make sure `enableServerPlugins: true` is set in your `SillyTavern/config.yaml`
3. **Restart SillyTavern**: Restart the application to load the new plugin

#### 🎵 **Step 3: Create Spotify App**
1. **Go to Spotify Developer**: Visit [https://developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. **Create App**: Log in and click "Create App"  
3. **Fill App Details**: Complete all required fields (see screenshot below)
4. **Set Redirect URI**: Add this exact URL to your app settings:
   ```
   http://127.0.0.1:8000/api/plugins/spotify-music/auth/callback
   ```
   *(Change `8000` to your SillyTavern port if different)*

![png](https://i.imgur.com/gsI9uPt.png)

#### 🔑 **Step 4: Get Spotify Credentials**
1. **Copy Credentials**: From your Spotify app's "Basic Information" section:
   - Copy the **Client ID**
   - Copy the **Client Secret** 
2. **Save These**: You'll need them in Step 6

![png](https://i.imgur.com/iuBm3t5.png)

#### 🤖 **Step 5: Install AI Preset** (Optional but Recommended)
1. **Copy Preset**: Copy the `Music.json` file from the ZIP to:
   ```
   SillyTavern/data/default-user/OpenAI Settings/Music.json
   ```
2. **Alternative**: Import via SillyTavern → **AI Response Configuration** → **Manage Presets** → **Import**

![png](https://i.imgur.com/saQjWXc.png)

#### ⚙️ **Step 6: Configure Extension**
1. **Restart SillyTavern**: Close and reopen SillyTavern to load the extension
2. **Open Extension**: Go to **Extensions** → **Spotify Music**  
3. **Enter Credentials**: Paste your Client ID and Client Secret from Step 4
4. **Save & Login**: Click "Save Credentials" then "Login to Spotify"
5. **Complete OAuth**: Complete the Spotify login in the popup window
6. **You're Ready!**: The extension will now automatically play music based on chat mood!

![png](https://i.imgur.com/6UTzqmJ.png)

## Usage

### Automatic Mode (Default)
The extension automatically triggers when:
- Characters send messages (CHARACTER_MESSAGE_RENDERED)
- You swipe between AI responses (MESSAGE_SWIPED)

### Model Selection
- **Music Preset Mode**: Uses dedicated Music.json preset for mood analysis
- **Current Model Mode**: Uses your currently selected AI model

### Manual Controls
- **Manual Trigger**: Force mood analysis and song selection
- **Test Liked Songs**: Verify your Spotify connection and fallback system
- **Enable Liked Songs Fallback**: Toggle intelligent fallback system

### Search Algorithm
The extension uses a 4-tier search strategy:
1. **Exact Match**: Full song title and artist
2. **Partial Match**: Song title with first artist word
3. **Song Only**: Just the song title
4. **Liked Songs Fallback**: Plays from your saved collection

## Configuration Options

### Spotify Settings
- Client ID and Secret from your Spotify Developer app
- Automatic credential validation and status display
- Secure OAuth flow with proper scopes

### Behavior Settings
- **Use Liked Songs Fallback**: Enable/disable intelligent fallback
- **Model Selection**: Choose between Music preset or current model
- **Manual Trigger**: Override automatic behavior when needed

### Music.json Preset Configuration
When using Music Preset Mode, the extension looks for a preset named "Music.json". **Use the preset included in this repository:**
- Download `Music.json` from this GitHub repository
- Import it into SillyTavern via AI Response Configuration → Manage Presets
- The included preset is pre-optimized for:
  - Mood analysis and emotional context recognition
  - Concise music recommendations in the format: "Song Title by Artist Name"
  - Fast response times for seamless music integration
  - Understanding of various music genres and emotional associations
## Required Spotify Scopes

The extension requests these Spotify permissions:
- `user-read-playback-state`: Check current playback status
- `user-modify-playback-state`: Control music playback
- `user-read-currently-playing`: Get current track info
- `user-library-read`: Access your Liked Songs for fallback

## Troubleshooting

### Common Issues


**"Extension initialization failed" or "INIT FAILED"**
- Ensure `enableServerPlugins: true` is set in your SillyTavern `config.yaml`
- Restart SillyTavern after making config changes
- Check that the server plugin files are in the correct `plugins/spotify-music/` directory
**"Cannot play - not logged into Spotify"**
- Click "Login to Spotify" and complete OAuth flow
- Check that popup windows aren't blocked

**"AI suggestion failed"**
- Verify your AI model is responding
- Check that you have imported the Music.json preset from this GitHub repository
- Verify the preset is named exactly "Music.json" in SillyTavern
- The system will automatically fall back to Liked Songs
**"Failed to play song"**
- Ensure Spotify is open and you have Premium
- Check that you have an active device in Spotify
- Verify the suggested song exists in Spotify's catalog

**Search fails frequently**
- Enable "Use Liked Songs Fallback" for better reliability
- The multi-tier algorithm should improve success rates
- Check Spotify connectivity and Premium status

### Debug Information
The extension provides detailed console logging with prefix `[Spotify Music]` for troubleshooting.

## Technical Details

### Architecture
- **Frontend**: SillyTavern extension with event-driven automation
- **Backend**: Express.js plugin with Spotify Web API integration
- **Authentication**: OAuth 2.0 with secure credential storage
- **Search**: Multi-strategy algorithm with intelligent fallbacks

### Event Integration
- Hooks into SillyTavern's message rendering system
- Respects user preferences and current chat context
- Automatic model switching based on configuration

### Security Features
- CSRF token validation for all requests
- Encrypted credential storage
- Proper OAuth scope management
- No sensitive data in client-side code

## Credits

Originally created by **NemoVonNirgend** as the MoodMusic extension. This version has been enhanced and rebranded as **Spotify Music** with comprehensive improvements for production use.

**Original Creator**: NemoVonNirgend  
**Original Repository**: https://github.com/NemoVonNirgend/SIllytavern-Moodmusic-extension  
**Enhanced by**: @SpicyMarinara  
**This Repository**: https://github.com/SpicyMarinara/SillyTavern-Spotify-Music-Extension  
**Version**: 3.0

## License

This extension is open source. Please check the LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit issues, feature requests, or pull requests to improve the extension.

## Contact

Discord: `marinara_spaghetti`
