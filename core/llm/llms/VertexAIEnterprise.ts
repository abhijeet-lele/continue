

import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";
import { renderChatMessage } from "../../util/messageContent.js";
import { BaseLLM } from "../index.js";
import { streamResponse } from "../stream.js";


const fs = require("fs");
const jwt = require("jsonwebtoken");

import Gemini from "./Gemini.js";

class VertexAIEnterprise extends BaseLLM {
  static providerName = "vertexai_enterprise";
  declare apiBase: string;
  declare vertexProvider: "gemini" | "unknown";

  declare geminiInstance: Gemini;
  declare region: string;
  declare projectId: string;
  declare keyfile_json_path: string;
  declare model: string;
  private tokenCache: {token:string, expiresAt:number} | null = null;

  static defaultOptions: Partial<LLMOptions> | undefined = {
    maxEmbeddingBatchSize: 250,
    region: "us-central1",
  };


  constructor(_options: LLMOptions) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    super(_options);
        if (!_options.region) {
      throw new Error("region is required but not provided");
    }
    this.region = _options.region;
    if (!_options.projectId) {
      throw new Error("projectId is required but not provided");
    }
    this.projectId = _options.projectId;
    if (!_options.keyfile_json_path) {
      throw new Error("keyfile_json_path is required but not provided");
    }
    this.keyfile_json_path = _options.keyfile_json_path;

    if (!_options.model) {
      throw new Error("model is required but not provided");
    }
    this.model = _options.model;

    if (this.region !== "us-central1") {
      // Any region outside of us-central1 has a max batch size of 5.
      _options.maxEmbeddingBatchSize = Math.min(
        _options.maxEmbeddingBatchSize ?? 5,
        5,
      );
    }


    this.vertexProvider = this.model.includes("gemini")
            ? "gemini"
            : "unknown";
   
    this.geminiInstance = new Gemini(_options);
  }

  private async generateGoogleAuthToken(): Promise<string> {
  try{
    // check if the token is still valid
    const now = Math.floor(Date.now() / 1000);
    if (this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.token;
    }
    if (!this.keyfile_json_path) {
      throw new Error("keyfile_json_path is required but not provided");
    }
    // step 1: Read the keyfile
    const keyfile = JSON.parse(
      fs.readFileSync(this.keyfile_json_path, "utf8"),
    );
    const {client_email, private_key} = keyfile;

   // step 2: create the JWT for the service account
   const nowInSeconds = Math.floor(Date.now() / 1000);
   const jwtPayload = {
        iss: client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: "https://oauth2.googleapis.com/token",
        iat: nowInSeconds,
        exp: nowInSeconds + 3600, // 1 hour expiration
   }
   const signedJwt = jwt.sign(jwtPayload, private_key, {
        algorithm: "RS256"});
    // step 3: make http post request to Google's OAuth 2.0 token endpoint
    const tokenEndpoint = "https://oauth2.googleapis.com/token";
    const response = await super.fetch(tokenEndpoint, {
      method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: signedJwt,
        }),
   });
    if (!response.ok) {
      throw new Error(
        `Failed to get access token: ${response.status} ${response.statusText}`,
      );
    }
    const tokenData = await response.json();
    const token = tokenData.access_token;
    const expiresIn = tokenData.expires_in;
    this.tokenCache = {
      token,
      expiresAt: now + expiresIn - 60, // subtract 60 seconds for safety
    };
    return token;
  } catch (error) {
    console.error(`Failed to generate Google Auth token: ${error.message}`);
    throw error;
  }
  }

  
  // Gemini
  private async *streamChatGemini(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    try {

        const token = await this.generateGoogleAuthToken();
        const apiUrl = `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${this.model}:generateContent`;
        const body = this.geminiInstance.prepareBody(messages, options, false);




    const response = await super.fetch(apiUrl, {
      method: "POST",
     
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "model-builder/1.10.0 grpc-node/1.10.0",
        },
        body: JSON.stringify(body),
    });

    for await (const message of this.geminiInstance.processGeminiResponse(
      streamResponse(response),
    )) {
      yield message;
    }
  }
    catch (error) {
        console.error(`Failed to stream chat from Gemini: ${error.message}`);
        throw error;
    }
}
  // Manager functions

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    

    // Conditionally apply removeSystemMessage
    const convertedMsgs = this.geminiInstance.removeSystemMessage(messages);

    if (this.vertexProvider === "gemini") {
      yield* this.streamChatGemini(convertedMsgs, options);
    } else {
        throw new Error(`Unsupported model: ${options.model}`);
    }
    }
  

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const message of this._streamChat(
      [{ content: prompt, role: "user" }],
      signal,
      options,
    )) {
      yield renderChatMessage(message);
    }
  }

 
}

export default VertexAIEnterprise;
