from flask import Flask, request
import os, requests

app = Flask(__name__)
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")

def send_message(chat_id, text):
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    requests.post(url, json={"chat_id": chat_id, "text": text})

# ✅ works for both "/" and "/api/index"
@app.route("/", methods=["GET"])
@app.route("/api/index", methods=["GET"])
def home():
    return "Bot is running!"

# ✅ works for "/<token>" and "/api/index/<token>"
@app.route(f"/{os.getenv('TELEGRAM_TOKEN')}", methods=["POST"])
@app.route(f"/api/index/{os.getenv('TELEGRAM_TOKEN')}", methods=["POST"])
def telegram_webhook():
    data = request.get_json()
    if "message" in data:
        chat_id = data["message"]["chat"]["id"]
        text = data["message"].get("text", "")
        reply = f"You said: {text}"
        send_message(chat_id, reply)
    return "ok"
