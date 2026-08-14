# 上游来源 (Upstream)

本目录是第三方技能 **book-to-skill** 的 vendored 副本，不是本仓库自研代码。

- 仓库：https://github.com/virgiliojr94/book-to-skill
- 提交：`c4c5e948caaa912c9e2024b925a7cdee9237b0c0`
- 许可：见 `LICENSE.md`

## 为什么放在仓库里

远程会话容器是临时的，`~/.claude/skills/` 里的内容在会话结束后会丢失。
装在 `.claude/skills/` 下可以随仓库一起持久化，任何人 clone 后都能直接用。
`SKILL.md` 本身就会在 `.claude/skills/book-to-skill/scripts/extract.py`
这个路径下探测自己的脚本，所以项目级安装是官方支持的方式之一。

## 相对上游做的裁剪

只保留运行技能所需的部分，去掉了纯项目基建：

- 保留：`SKILL.md`、`book_to_skill/`、`scripts/`、`tools/`、`docs/*.md`、
  `README.md`、`LICENSE.md`、`CHANGELOG.md`、`pyproject.toml`
- 去掉：`.git/`、`.github/`、`tests/`、`docs/assets/`（约 1.1 MB 站点图片）、
  `mkdocs.yml`、`overrides/`、`cliff.toml`

## 更新方式

```bash
git clone --depth 1 https://github.com/virgiliojr94/book-to-skill.git /tmp/b2s
rsync -a --delete \
  --exclude .git --exclude .github --exclude tests \
  --exclude docs/assets --exclude mkdocs.yml --exclude overrides \
  --exclude cliff.toml --exclude UPSTREAM.md \
  /tmp/b2s/ .claude/skills/book-to-skill/
```

更新后记得把本文件里的提交 SHA 一并改掉。

## 可选依赖

技能开箱即用（所有格式都有标准库兜底），装上以下依赖可以提升提取质量：

```bash
python3 .claude/skills/book-to-skill/scripts/extract.py --check   # 看当前缺什么
pip3 install pypdf pdfminer.six ebooklib beautifulsoup4 python-docx striprtf
sudo apt install poppler-utils        # pdftotext，纯文字 PDF 最快
pip3 install docling                  # 含代码/表格的技术类 PDF
```

只有 MOBI / AZW / AZW3 是硬依赖，需要 Calibre 的 `ebook-convert`。

## 用法

```
/book-to-skill <文件|目录|glob> [技能名]
```

生成的技能会写到技能目录下，之后用 `/<技能名> <关键词>` 查询。
详见 `docs/usage.md`。
