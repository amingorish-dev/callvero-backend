import twilio from "twilio";
import { config } from "./config";

export function getTwilioClient() {
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    return null;
  }
  return twilio(config.twilioAccountSid, config.twilioAuthToken);
}
