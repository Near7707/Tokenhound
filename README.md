# Tokenhound

A SillyTavern extension that sniffs out where your prompt tokens go.

[한국어 설명은 아래에 있어요](#한국어)

Tokenhound shows how much of the context each part of the prompt used: preset, character card, persona, world info, extensions, and chat history. A small black-and-white pixel hound keeps you company on screen. It gets more tired as the context fills up.

## Features

- **Choose how it shows on screen**: a small button you can drag anywhere (default), a bar above the input, a hound that wanders along the input box, or nothing at all (open it from the wand menu). Tap the hound to open the window.
- **Breakdown**: tokens and percent for each part of the prompt. Shows the change from the last turn.
- **World info and extensions**: tap to see each world info entry and each extension prompt.
- **Chat history**: how many messages fit, and how many older ones were left out.
- **Prompt cache hints**: where the prompt first changed since the last turn, for example "new world info entry" or "older messages scrolled out".
- **Usage reported by the API**: input, cache hit, output, and thinking tokens, when your API reports them.
- **Reply size**: estimated tokens of the last reply and its thinking part.
- **Biggest items**, a **trend line**, and a **turn log** for each chat.
- **Estimate next**: count the next prompt without sending it.
- **Current model and connection profile**.
- English and Korean. By default it follows your SillyTavern language.

The hound has four moods: relaxed, sniffing, panting, and sleepy. You can change the steps (default 50 / 85 / 95%) in the settings.

## Install

1. In SillyTavern, open **Extensions** › **Install extension**.
2. Paste `https://github.com/Near7707/Tokenhound` and install.

Settings are in **Extensions › Tokenhound**. The ⚙ button in the window has quick settings.

## How it counts

- Counts come from SillyTavern's tokenizer, so they are **estimates**. Your model may count a little differently. The "Reported by the API" box shows the real numbers when your API sends them.
- Tokenhound finds each part by looking for its text in the final prompt. "Preset and other" is what's left: system prompts, formatting, and anything it couldn't match.
- Regex scripts or macros that change text only in the prompt can make some parts land in "Preset and other".
- SillyTavern doesn't report world info during a dry run. "Estimate next" reuses the entries from the last real turn and doesn't include the message you're typing.
- The usage box depends on your API. Some APIs don't send usage when streaming.

## Safety

- Read-only. Tokenhound doesn't add anything to the prompt, and it doesn't change chats, cards, or other extensions' settings.
- To read the API usage, it reads a copy of the reply your API sends back to SillyTavern. Nothing is sent anywhere. You can turn this off in the settings.
- The turn log stores numbers, entry names, and the model name, not your messages. It keeps up to 100 chats.
- By default the log is also saved as small files in your SillyTavern user files (the same folder as Data Bank uploads), so your PC and phone see the same log. Chat files are not touched. Turn off "Share the turn log between devices" to keep it in this browser only.
- SillyTavern's Data Maid may list these files (`tokenhound-….json`) as unused. Deleting them only removes the log.

## Group chats

Group chats are supported. The card row shows the name of the character who is speaking.

---

## 한국어

실리태번 프롬프트에서 토큰이 어디에 얼마나 들어갔는지 찾아 주는 확장이에요.

프리셋, 캐릭터 카드, 페르소나, 로어북, 확장, 대화 기록이 컨텍스트를 각각 얼마나 썼는지 보여 줘요. 화면에는 흑백 도트 하운드가 함께 있고, 컨텍스트가 찰수록 점점 지쳐요.

### 기능

- **화면 표시 방식 고르기**: 끌어서 아무 데나 옮길 수 있는 작은 버튼(기본), 입력칸 위 막대, 입력칸 위를 돌아다니는 강아지, 아무것도 안 띄우기(마법봉 메뉴에서 열기) 중에 골라요. 하운드를 누르면 창이 열려요.
- **항목별 토큰**: 항목마다 토큰과 비율을 보여 주고, 지난 턴보다 얼마나 늘고 줄었는지도 보여 줘요.
- **로어북과 확장**: 누르면 로어북 항목별, 확장별로 펼쳐서 볼 수 있어요.
- **대화 기록**: 메시지가 몇 개 들어갔고, 오래된 메시지가 몇 개 빠졌는지 보여 줘요.
- **프롬프트 캐시 힌트**: 지난 턴과 비교해서 프롬프트가 처음 바뀐 곳을 알려 줘요. 예를 들면 "새 로어북 항목"이나 "오래된 메시지가 밀려남" 같은 거예요.
- **API가 알려 준 사용량**: API가 알려 주면 입력, 캐시 적중, 출력, 생각 토큰을 보여 줘요.
- **답 크기**: 마지막 답과 생각 부분이 몇 토큰인지 예상해서 보여 줘요.
- **큰 항목 순위**, **추세 그래프**, 채팅방별 **턴 기록**도 있어요.
- **미리 세기**: 보내지 않고 다음 프롬프트를 세 봐요.
- **지금 모델과 연결 프로필**을 보여 줘요.
- 영어와 한국어를 지원해요. 처음에는 실리태번 언어 설정을 따라가요.

하운드 표정은 느긋함, 킁킁, 헥헥, 졸음 네 단계예요. 단계 기준(기본 50 / 85 / 95%)은 설정에서 바꿀 수 있어요.

### 설치

1. 실리태번에서 **확장** › **확장 설치**를 열어요.
2. `https://github.com/Near7707/Tokenhound`를 붙여 넣고 설치해요.

설정은 **확장 › Tokenhound**에 있어요. 창 안의 ⚙ 버튼에서는 자주 쓰는 설정만 빠르게 바꿀 수 있어요.

### 세는 방법

- 숫자는 실리태번 토크나이저로 센 **예상치**예요. 모델이 실제로 세는 값과 조금 다를 수 있어요. API가 사용량을 보내 주면 "API가 알려 준 사용량" 칸에 실제 숫자가 나와요.
- 최종 프롬프트에서 각 항목의 글을 찾아서 나눠요. "프리셋 / 기타"는 그러고 남은 부분이에요. 시스템 프롬프트, 서식, 그리고 어디에도 맞추지 못한 글이 여기 들어가요.
- 프롬프트에서만 글을 바꾸는 정규식이나 매크로가 있으면, 그 부분이 "프리셋 / 기타"로 들어갈 수 있어요.
- 실리태번은 미리 세기를 할 때 로어북 정보를 알려 주지 않아요. 그래서 "미리 세기"는 마지막 턴의 로어북 항목을 다시 쓰고, 지금 입력 중인 메시지는 포함하지 않아요.
- 사용량 칸은 API에 따라 달라요. 스트리밍일 때는 사용량을 보내지 않는 API도 있어요.

### 안전

- 읽기만 해요. 프롬프트에 아무것도 넣지 않고, 채팅, 캐릭터 카드, 다른 확장 설정도 바꾸지 않아요.
- API 사용량을 보려고, API가 실리태번에 돌려준 답의 복사본을 읽어요. 아무 데도 보내지 않아요. 설정에서 끌 수 있어요.
- 턴 기록에는 숫자, 항목 이름, 모델 이름만 저장하고 메시지 내용은 저장하지 않아요. 채팅방 100개까지 남아요.
- 기본으로 실리태번 사용자 파일 폴더(데이터 뱅크 파일이 들어가는 곳)에도 작은 파일로 저장해요. 그래서 PC와 폰에서 같은 기록을 봐요. 채팅 파일은 건드리지 않아요. "턴 기록을 기기끼리 같이 보기"를 끄면 이 브라우저에만 저장해요.
- 실리태번 데이터 정리 도구(Data Maid)에 이 파일들(`tokenhound-….json`)이 "안 쓰는 파일"로 보일 수 있어요. 지워도 기록만 사라져요.

### 그룹 채팅

그룹 채팅도 지원해요. 캐릭터 카드 줄에는 지금 말하는 캐릭터 이름이 나와요.
