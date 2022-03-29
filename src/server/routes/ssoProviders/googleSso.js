/*
 * Copyright 2021-2022 Inclusive Design Research Centre, OCAD University
 * All rights reserved.
 *
 * Defines constants and functions to handle the SSO workflow using Google as
 * the provider.
 *
 * Licensed under the New BSD license. You may not use this file except in
 * compliance with this License.
 *
 * You may obtain a copy of the License at
 * https://github.com/fluid-project/personal-data-server/blob/main/LICENSE
 */

"use strict";

const axios = require("axios");

const REDIRECT_URI = "http://localhost:3000/sso/google/login/callback";

const options = {
    // Google authorization endpoint to start their authorization workflow.
    authorizeUri: "https://accounts.google.com/o/oauth2/auth",

    // Google "get access token" and "refresh access token" endpoints.
    accessTokenUri: "https://accounts.google.com/o/oauth2/token",
    accessType: "offline",

    // Google get user info endpoints.
    userInfoUri: "https://www.googleapis.com/oauth2/v2/userinfo",

    // Google "use access token endpoint"
    credentialsUri: "https://oauth2.googleapis.com/token",

    // URI that Google uses to call back to the Personal Data Server for
    // logging in.
    redirectUri: REDIRECT_URI,
    encodedRedirectUri: encodeURIComponent(REDIRECT_URI),

    // Identifier for retrieving the client information (e.g. id and secret)
    // for the Personal Data Server database.
    provider: "google",

    // Default user preferences.
    // TODO: This is a hardcoded value to temporarily fill up the value of `local_user.preferences`.
    // It will not be needed when the workflow of defining user preferences is sorted out.
    defaultPreferences: {
        textSize: 1.2,
        lineSpace: 1.2
    }
};

class GoogleSso {

    get REDIRECT_URI() { return REDIRECT_URI; };
    get options() { return options; };

    /**
     * Execute the first step in the SSO workflow, making an authorize request
     * to Google.  This throws if there is an error retrieving the client
     * information from the database.
     *
     * @param {Object} res - The express response used to redirect to Google
     * @param {Object} ssoDbOps - Used to retrieve this client's id and secret
     * @param {Object} options - Other options specific to Google SSO
     * @param {String} options.authorizeUri - Google's authorization endpoint
     * @param {String} options.encodedRedirectUri - The endpoint that Google will call
     * @param {String} options.accessType - The type of access to Google needed for SSO
     * @param {String} ssoState - The SSO state
     *
     */
    async authorize(res, ssoDbOps, options, ssoState) {
        // Send the authorize request to the SSO provider
        const clientInfo = await ssoDbOps.getSsoClientInfo(this.options.provider);
        const authRequest = `${options.authorizeUri}?client_id=${clientInfo.client_id}&redirect_uri=${options.encodedRedirectUri}&scope=openid+profile+email&response_type=code&state=${ssoState}&access_type=${options.accessType}`;
        console.debug("Google /authorize request: ", authRequest);
        res.redirect(authRequest);
    };

    /**
     * Handle the redirect callback from Google:
     * - request an access token,
     * - request the user's profile
     * - create/update database with respect to the user, access_token, and
     *   sso_user_account records.
     * This throws if an error occurs at any step.
     *
     * @param {Object} req - The express request that triggered the workflow
     * @param {Object} req.query.code - Token from Google to use to request access token
     * @param {Object} ssoDbOps - Used to update user, access_token, and sso_user_account
     *                             records
     * @param {Object} options - Other options specific to Google SSO
     * @return {String} - The access token record containing the access token returned by the SSO provider.
     */
    async handleCallback(req, ssoDbOps, options) {
        try {
            const accessTokenResponse = await this.fetchAccessToken(req.query.code, ssoDbOps, options.accessTokenUri, options.redirectUri, options.provider);
            if (accessTokenResponse.status !== 200) {
                return accessTokenResponse;
            }
            const accessTokenInfo = accessTokenResponse.data;
            const userInfoResponse = await this.fetchUserInfo(accessTokenInfo.access_token, options.userInfoUri, options.provider);
            if (userInfoResponse.status !== 200) {
                return userInfoResponse;
            }
            const userInfo = userInfoResponse.data;
            const accessTokenRecord = await this.storeUserAndAccessToken(userInfo, accessTokenInfo, ssoDbOps, options.provider, options.defaultPreferences);
            return accessTokenRecord;
        } catch (e) {
            throw e;
        }
    };

    /**
     * Request an access token from Google SSO.
     *
     * @param {String} code - The code provided by Gogole to exchange for the access token
     * @param {Object} ssoDbOps - Database access for retrieving client id and secret.
     * @param {Object} accessTokenUri - URI to Google's access token endpoint.
     * @param {Object} redirectUri - URI for Google's callback.
     * @param {Object} provider - Identifier to use to find this client's id and secret in the database.
     * @return {Object} The response from Google's `/token` endpoint, either a success with an access token
     * (status 200), or an error response.
     */
    async fetchAccessToken(code, ssoDbOps, accessTokenUri, redirectUri, provider) {
        try {
            const clientInfo = await ssoDbOps.getSsoClientInfo(provider);
            const response = await axios({
                method: "post",
                url: accessTokenUri,
                data: {
                    grant_type: "authorization_code",
                    code: code,
                    redirect_uri: redirectUri,
                    client_id: clientInfo.client_id,
                    client_secret: clientInfo.client_secret
                },
                "Content-type": "application/json"
            });
            console.debug("Status: %s: access token for %s", response.status, provider);
            return response;
        } catch (e) {
            return e.response;
        }
    };

    /**
     * Request the SSO users's email and profile from Google.
     * @param {Object} accessToken - The access token provided by Google.
     * @param {Object} userInfoUri - URI to Google's user profile endpoint.
     * @param {Object} provider - The SSO provider.
     * @return {Object} The response from Google's `/userInfo` endpoint, either
     *                  a successful response containing the user's profile
     *                  (status 200) or an error response.
     */
    async fetchUserInfo(accessToken, userInfoUri, provider) {
        const fullUri = `${userInfoUri}?` + new URLSearchParams({
            access_token: accessToken,
            alt: "json"
        });
        try {
            const response = await axios.get(fullUri);
            console.debug("Status: %s: user profile for %s", response.status, provider);
            return response;
        } catch (e) {
            return e.response;
        }
    };

    /**
     * Create and persist user, access token, and SSO account records based
     * on the given information.
     *
     * @param {Object} userInfo - The information to use to create the sso user account record.
     * @param {Object} accessTokenInfo - The access token information object provided by the provider for
     *                               the user's access.
     * @param {Object} ssoDbOps - Database access for storing the user, access
     *                             token, and related records.
     * @param {Object} provider - Google provider id.
     * @param {Object} preferences - The default preferences for creating a user record.
     * @return {Object} Object that has the user, sso_user_account, sso_provider,
     *                  and access_token records.
     */
    async storeUserAndAccessToken(userInfo, accessTokenInfo, ssoDbOps, provider, preferences) {
        // Find if the sso account already in sso_user_account table
        let accessTokenRecord,
            ssoUserAccountRecord = await ssoDbOps.getSsoUserAccount(userInfo.id, provider);

        if (ssoUserAccountRecord === null) {
            // Create a new user record, a new sso user account and an access token.
            // TODO: the step of creating a new user record should be moved out of the SSO once the workflow
            // of connecting a user account and multiple SSO accounts is sorted out.
            const newUserRecord = await ssoDbOps.createUser(preferences);
            ssoUserAccountRecord = await ssoDbOps.createSsoUserAccount(newUserRecord.user_id, userInfo, options.provider);
            accessTokenRecord = await ssoDbOps.createAccessToken(ssoUserAccountRecord.sso_user_account_id, accessTokenInfo);
        } else {
            // Update the existing sso user account and access token
            ssoUserAccountRecord = await ssoDbOps.updateSsoUserAccount(ssoUserAccountRecord.sso_user_account_id, userInfo);
            accessTokenRecord = await ssoDbOps.updateAccessToken(ssoUserAccountRecord.sso_user_account_id, accessTokenInfo);
        }
        return accessTokenRecord;
    };
};

module.exports = new GoogleSso();
