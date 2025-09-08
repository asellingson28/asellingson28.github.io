fetch('nav.json')
    .then(response => response.json())
    .then(data => {
        const navList = document.getElementById('nav-list');

        data.forEach(item => {
            const li = document.createElement('li');
            const a = document.createElement('a');
            a.href = item.link;
            a.textContent = item.name;
            li.appendChild(a);
            navList.appendChild(li);
        });
    })
    .catch(error => console.error('Error loading navigation:', error));
