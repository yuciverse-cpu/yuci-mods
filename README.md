# yuci-mods

내가 만든 Claude 앱 mod을 한곳에 모아 두는 보관함입니다. 이 저장소 자체가 마켓플레이스라서, 여기에 있는 mod은 어느 컴퓨터, 어느 세션에서든 한 줄로 설치해서 쓸 수 있습니다.

## 설치

Claude Code 세션의 프롬프트에서:

```
/plugin install token-gauge --marketplace yuciverse-cpu/yuci-mods
```

터미널(셸)에서:

```
claude plugin install token-gauge --marketplace yuciverse-cpu/yuci-mods
```

처음이면 마켓플레이스를 추가할지 묻습니다(`y`). 이어서 설치 범위를 고르면 됩니다. 사용자 전체에 쓰려면 user 범위를 고르세요.

## 구조

```
Mods/
├─ .claude-plugin/marketplace.json   ← 보관함 목록(mod마다 한 줄)
└─ mods/
   └─ <mod 이름>/                    ← mod 하나(.claude-plugin/plugin.json, hooks/ …)
```

## 들어 있는 mod

| mod | 하는 일 |
|---|---|
| token-gauge | 프롬프트 위 한 줄로 토큰 사용량 관리(한도 리셋, 로그축약, 사용처, 캐시, 큰 작업 경고) |

## 새 mod 추가하기

1. `mods/<mod 이름>/` 폴더에 mod을 넣습니다.
2. `.claude-plugin/marketplace.json`의 `plugins`에 한 줄을 추가합니다.
   `{ "name": "<mod 이름>", "source": "./mods/<mod 이름>", "description": "한 줄 설명" }`
3. 설치: `claude plugin install <mod 이름> --marketplace yuciverse-cpu/yuci-mods`
4. GitHub에 올린 뒤 다른 컴퓨터에서는 `claude plugin update <mod 이름>`으로 최신 버전을 받습니다.
